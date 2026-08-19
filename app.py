import json
import os
import re
import tempfile
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

from sentiment import config as sentiment_config
from sentiment import jobs as sentiment_jobs
from sentiment import run as sentiment_run


def _utcnow():
    return datetime.now(timezone.utc).timestamp()

# === SETUP ===
# Key is read from an environment variable — never hardcoded.
# Local dev: put YOUTUBE_API_KEY=... in a .env file at the repo root (gitignored).
# Production (Railway etc.): set it as a real env var; load_dotenv() won't override that.
load_dotenv()
API_KEY = os.environ.get("YOUTUBE_API_KEY")
YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3"
TOOL_VERSION = "1.1.0"

app = Flask(__name__)

# Werkzeug 3.1 introduced a 500 KB default cap on *non-file* form fields
# (max_form_memory_size). The /analyze flywheel path posts the entire scrape_result
# as a single form field, so any reasonably large comment set blows past 500 KB and
# Werkzeug rejects the request with a 413 (an HTML error page) BEFORE the handler runs
# — which the frontend surfaces as "Backend did not return JSON". Raise the cap
# generously for large comment sets; keep MAX_CONTENT_LENGTH as an overall abuse
# backstop. (Requirements pin neither Flask nor Werkzeug, so this default arrived via
# a silent dependency upgrade — see requirements.txt.)
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB
app.config["MAX_FORM_MEMORY_SIZE"] = _MAX_UPLOAD_BYTES
app.config["MAX_CONTENT_LENGTH"] = _MAX_UPLOAD_BYTES

# Lock CORS to the frontend's origin in production. Set FRONTEND_ORIGIN to your
# deployed frontend URL (e.g. https://yt-frontend.up.railway.app). You can pass
# a comma-separated list for multiple origins. If it's unset, fall back to "*"
# so local dev and first-run deploys keep working.
_origins_env = os.environ.get("FRONTEND_ORIGIN", "").strip()
_origins = [o.strip() for o in _origins_env.split(",") if o.strip()] or "*"
CORS(app, resources={r"/*": {"origins": _origins}})


# ---------------------------------------------------------------------------
# YOUR ORIGINAL LOGIC — unchanged except API_KEY now comes from the env var.
# ---------------------------------------------------------------------------

def extract_video_id(url_or_id):
    """
    Extracts the 11-character YouTube video ID from a standard watch, youtu.be,
    embed, /shorts/ or /live/ URL, or returns it directly if it's already just the ID.
    """
    if len(url_or_id) == 11:
        return url_or_id

    regex = r'(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts|live)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})'
    match = re.search(regex, url_or_id)
    if match:
        return match.group(1)
    else:
        raise ValueError("Could not extract a valid YouTube Video ID. Please check your URL.")


def get_video_comments(video_id):
    """
    Fetches all comment threads for a single video ID, including text and nested replies.
    """
    video_comments = []
    next_page_token = None

    while True:
        url = f"{YOUTUBE_API_URL}/commentThreads?part=snippet,replies&videoId={video_id}&maxResults=100&key={API_KEY}"
        if next_page_token:
            url += f"&pageToken={next_page_token}"

        response = requests.get(url)

        if response.status_code == 403:
            raise Exception("Comments are likely disabled for this video, or your API key is invalid/out of quota.")
        elif response.status_code == 404:
            raise Exception("That video couldn't be found — check the link, or it may have been removed.")
        elif response.status_code != 200:
            # Surface the API's own reason where we can parse it; raw body as a last resort
            # so nothing is silently swallowed, just not shown as the primary line.
            reason = ""
            try:
                reason = response.json()["error"]["errors"][0].get("reason", "")
            except (ValueError, KeyError, IndexError):
                pass
            detail = f" ({reason})" if reason else f": {response.text}"
            raise Exception(f"API Error {response.status_code}{detail}")

        data = response.json()

        for item in data.get('items', []):
            top_comment = item['snippet']['topLevelComment']['snippet']

            comment_data = {
                'comment_id': item['id'],
                'author': top_comment.get('authorDisplayName'),
                'text': top_comment.get('textOriginal'),
                'likes': top_comment.get('likeCount'),
                'published_at': top_comment.get('publishedAt'),
                'replies': []
            }

            if 'replies' in item:
                for reply_item in item['replies']['comments']:
                    reply_snippet = reply_item['snippet']
                    comment_data['replies'].append({
                        'reply_id': reply_item['id'],
                        'author': reply_snippet.get('authorDisplayName'),
                        'text': reply_snippet.get('textOriginal'),
                        'likes': reply_snippet.get('likeCount'),
                        'published_at': reply_snippet.get('publishedAt')
                    })

            video_comments.append(comment_data)

        next_page_token = data.get('nextPageToken')
        if not next_page_token:
            break

    return video_comments


def get_video_metadata(video_id):
    """
    Fetches the video's title, channel, and publish date so the downstream
    AI tool has context without parsing the whole comment tree.
    """
    url = f"{YOUTUBE_API_URL}/videos?part=snippet,statistics&id={video_id}&key={API_KEY}"
    response = requests.get(url)
    if response.status_code != 200:
        return {"video_id": video_id}  # don't fail the whole job over metadata

    items = response.json().get("items", [])
    if not items:
        return {"video_id": video_id}

    snippet = items[0].get("snippet", {})
    stats = items[0].get("statistics", {})
    return {
        "video_id": video_id,
        "title": snippet.get("title"),
        "channel": snippet.get("channelTitle"),
        "published_at": snippet.get("publishedAt"),
        "view_count": stats.get("viewCount"),
        "like_count": stats.get("likeCount"),
        "comment_count_reported": stats.get("commentCount"),
    }


# ---------------------------------------------------------------------------
# THE WRAPPER — one route the artifact UI talks to.
# ---------------------------------------------------------------------------

@app.route("/scrape", methods=["POST"])
def scrape():
    if not API_KEY:
        return jsonify({"error": "Server is missing its YouTube API key. Set the YOUTUBE_API_KEY environment variable."}), 500

    body = request.get_json(silent=True) or {}
    url_or_id = (body.get("url") or "").strip()
    client_slug = body.get("client_slug") or None

    if not url_or_id:
        return jsonify({"error": "Please provide a YouTube URL."}), 400

    try:
        video_id = extract_video_id(url_or_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        comments = get_video_comments(video_id)
        metadata = get_video_metadata(video_id)
    except Exception as e:
        # Surfaces "comments disabled / quota" and any API error to the UI
        return jsonify({"error": str(e)}), 502

    total_replies = sum(len(c["replies"]) for c in comments)
    source_id = f"yt:{video_id}"
    generated_at = datetime.now(timezone.utc).isoformat()

    result = {
        "provenance": {
            "run_id": f"scrape-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}",
            "generated_at": generated_at,
            "tool": "scraper",
            "tool_version": TOOL_VERSION,
            "client_slug": client_slug,
            "source_ids": [source_id],
        },
        "source_id": source_id,
        "video": metadata,
        "scraped_at": generated_at,
        "summary": {
            "top_level_comments": len(comments),
            "total_replies": total_replies,
            "total_items": len(comments) + total_replies,
        },
        "comments": comments,  # threaded: replies nested under each parent
    }

    return jsonify(result)


# ---------------------------------------------------------------------------
# SENTIMENT ANALYZER — scrape -> ingest -> configs -> prompt -> [model, gated]
# ---------------------------------------------------------------------------

@app.route("/sentiment/options", methods=["GET"])
def sentiment_options():
    """Self-populates the purpose/client dropdowns from the config folders."""
    return jsonify({
        "purposes": [
            {k: p[k] for k in ("purpose_id", "display_name", "one_line", "status")}
            for p in sentiment_config.available_purposes()
        ],
        "clients": [
            {k: c[k] for k in ("client_slug", "client_name")}
            for c in sentiment_config.available_clients()
        ],
        "analyzer_enabled": bool(os.environ.get("ANTHROPIC_API_KEY")),
    })


@app.route("/analyze", methods=["POST"])
def analyze():
    purpose_id = (request.form.get("purpose_id") or "").strip()
    client_slug_input = (request.form.get("client_slug") or "").strip().lower() or None
    scope = (request.form.get("scope") or "per-video").strip()
    transcript = request.form.get("transcript") or None
    team_notes = request.form.get("team_notes") or None

    if not purpose_id:
        return jsonify({"error": "purpose_id is required."}), 400

    uploaded_file = request.files.get("file")
    scrape_result_raw = request.form.get("scrape_result")

    uploaded_purpose_path = None
    if request.files.get("purpose_config"):
        f = request.files["purpose_config"]
        tmp = tempfile.NamedTemporaryFile(suffix=".md", delete=False)
        f.save(tmp.name)
        uploaded_purpose_path = tmp.name

    uploaded_client_path = None
    if request.files.get("client_config"):
        f = request.files["client_config"]
        tmp = tempfile.NamedTemporaryFile(suffix=".md", delete=False)
        f.save(tmp.name)
        uploaded_client_path = tmp.name

    try:
        if uploaded_file and uploaded_file.filename:
            rows, source_ids, client_slug, diagnostics = sentiment_run.ingest_from_upload(
                uploaded_file, client_slug_override=client_slug_input
            )
        elif scrape_result_raw:
            try:
                scrape_result = json.loads(scrape_result_raw)
            except json.JSONDecodeError:
                return jsonify({"error": "scrape_result is not valid JSON."}), 400
            rows, source_ids, client_slug, diagnostics = sentiment_run.ingest_from_scrape_result(
                scrape_result, client_slug_override=client_slug_input
            )
        else:
            return jsonify({
                "error": "Provide either an uploaded comments file ('file') or an in-app "
                         "scrape result ('scrape_result')."
            }), 400
    except Exception as e:
        return jsonify({"error": f"Ingest failed: {e}"}), 422

    # The fast half (config resolution + prompt assembly) runs inline — sub-second.
    try:
        prep = sentiment_run.prepare(
            rows=rows,
            source_ids=source_ids,
            client_slug=client_slug,
            diagnostics=diagnostics,
            purpose_id=purpose_id,
            client_slug_input=client_slug_input,
            scope=scope,
            transcript=transcript,
            team_notes=team_notes,
            uploaded_purpose_path=uploaded_purpose_path,
            uploaded_client_path=uploaded_client_path,
        )
    except Exception as e:
        app.logger.exception("/analyze failed during prepare()")
        return jsonify({"error": f"Analysis prep failed: {e}"}), 502
    finally:
        for p in (uploaded_purpose_path, uploaded_client_path):
            if p:
                os.unlink(p)

    # No API key → the "not_enabled" stub is terminal and needs no model call. Return it
    # synchronously exactly as before (503 + the assembled prompt + diagnostics).
    if prep["terminal"]:
        return jsonify(prep["result"]), 503

    # Key present → the slow Claude call would blow past Railway's ~300s edge timeout if held
    # on this request. Start it on a background thread and hand the client a job_id to poll.
    job_id = sentiment_jobs.create_job(_utcnow())
    sentiment_jobs.run_in_thread(job_id, lambda: sentiment_run.run_model(prep), _utcnow)
    return jsonify({"status": "running", "job_id": job_id}), 202


@app.route("/analyze/status/<job_id>", methods=["GET"])
def analyze_status(job_id):
    job = sentiment_jobs.get_job(job_id)
    if job is None:
        return jsonify({"error": "Unknown or expired job_id.", "status": "not_found"}), 404
    if job["status"] == "running":
        return jsonify({"status": "running"}), 200
    if job["status"] == "error":
        return jsonify({"status": "error", "error": job["error"]}), 200
    # done — return the exact result shape the frontend already renders.
    return jsonify(job["result"]), 200


@app.errorhandler(RequestEntityTooLarge)
def handle_too_large(e):
    # Return JSON (not Werkzeug's default HTML) so the frontend can show a real message
    # instead of "Backend did not return JSON" if a payload ever exceeds the cap above.
    limit_mb = _MAX_UPLOAD_BYTES // (1024 * 1024)
    return jsonify({
        "error": f"That comment set is too large to submit in one request (limit {limit_mb} MB). "
                 "Try a narrower scrape or upload the comments as a file."
    }), 413


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "key_loaded": bool(API_KEY)})


if __name__ == "__main__":
    # Local dev only. On Railway, gunicorn (see Procfile) runs the app and
    # binds to $PORT. Honor $PORT here too so the two paths match.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
