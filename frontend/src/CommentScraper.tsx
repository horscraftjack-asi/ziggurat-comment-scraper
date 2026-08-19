import { useEffect, useMemo, useRef, useState } from "react";
import {
  ANALYTICS_URL,
  BACKEND_URL,
  analyticsLinkFor,
  formatBytes,
  loadRecentScrapes,
  normalizeClientSlug,
  saveRecentScrape,
  csvField,
  timeAgo,
  type ScrapeResult,
  type RecentScrape,
} from "./shared";

type Status = "idle" | "loading" | "done" | "error";

interface CommentScraperProps {
  onSendToAnalyzer: (result: ScrapeResult) => void;
  onGoToAnalyzerStandalone: () => void;
}

const STEP_LABELS = ["Fetch metadata", "Paginate comments", "Thread replies", "Build JSON"];

const LOG_ROTATION = [
  "> resolving video id…",
  "> fetching video metadata…",
  "> paginating comment threads…",
  "> still working — large threads take a little longer…",
  "> almost there…",
];

const YOUTUBE_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts|live)\/|\S*?[?&]v=)|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

function isLikelyYouTubeUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return true;
  return YOUTUBE_URL_RE.test(trimmed);
}

function initials(name: string | undefined): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts.slice(0, 2).map((p) => p[0]);
  return (chars.join("") || name.slice(0, 2)).toUpperCase();
}

function topThreads(comments: ScrapeResult["comments"], n = 2) {
  return [...(comments ?? [])]
    .filter((c) => c.text)
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    .slice(0, n);
}

function commentsPerDay(comments: ScrapeResult["comments"]): number[] | null {
  const timestamps: number[] = [];
  for (const c of comments ?? []) {
    if (c.published_at) timestamps.push(Date.parse(c.published_at));
    for (const r of c.replies ?? []) {
      if (r.published_at) timestamps.push(Date.parse(r.published_at));
    }
  }
  const valid = timestamps.filter((t) => !Number.isNaN(t));
  if (valid.length < 2) return null;

  const earliest = Math.min(...valid);
  const dayMs = 24 * 60 * 60 * 1000;
  const buckets = new Array(14).fill(0);
  let usedDays = 0;
  for (const t of valid) {
    const day = Math.floor((t - earliest) / dayMs);
    if (day >= 0 && day < 14) buckets[day]++;
  }
  usedDays = new Set(buckets.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)).size;
  return usedDays >= 2 ? buckets : null;
}

const BAR_COLORS = ["#242c22", "#2f3a2a", "#3f5a2b", "#7fb83a", "#B8F24A"];
function barColor(ratio: number): string {
  const idx = Math.min(BAR_COLORS.length - 1, Math.floor(ratio * BAR_COLORS.length));
  return BAR_COLORS[idx];
}

export default function CommentScraper({
  onSendToAnalyzer,
  onGoToAnalyzerStandalone,
}: CommentScraperProps) {
  const [url, setUrl] = useState(
    () => new URLSearchParams(window.location.search).get("url") || ""
  );
  const [clientSlug, setClientSlug] = useState(
    () => new URLSearchParams(window.location.search).get("client_slug") || ""
  );
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [recent, setRecent] = useState<RecentScrape[]>(() => loadRecentScrapes());
  const [reportCopied, setReportCopied] = useState(false);

  const [stepIndex, setStepIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [finishedInMs, setFinishedInMs] = useState<number | null>(null);

  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const startedAtRef = useRef(0);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  useEffect(() => clearTimers, []);

  const run = async () => {
    if (!url.trim()) return;
    if (!isLikelyYouTubeUrl(url)) {
      setUrlInvalid(true);
      return;
    }
    setUrlInvalid(false);
    clearTimers();
    setStatus("loading");
    setErrorMsg("");
    setResult(null);
    setStepIndex(0);
    setElapsedSec(0);
    setLogLines([LOG_ROTATION[0]]);
    setFinishedInMs(null);
    startedAtRef.current = Date.now();

    timersRef.current.push(setTimeout(() => setStepIndex(1), 700));

    const tickElapsed = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    timersRef.current.push(tickElapsed as unknown as ReturnType<typeof setTimeout>);

    let logCount = 1;
    const tickLog = setInterval(() => {
      setLogLines((lines) => [...lines, LOG_ROTATION[logCount % LOG_ROTATION.length]].slice(-4));
      logCount += 1;
    }, 2200);
    timersRef.current.push(tickLog as unknown as ReturnType<typeof setTimeout>);

    const normalizedSlug = normalizeClientSlug(clientSlug);
    const requestBody = {
      url: url.trim(),
      client_slug: normalizedSlug || null,
    };

    const fetchUrl = `${BACKEND_URL}/scrape`;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(
          `Backend did not return JSON — called ${fetchUrl}. ` +
            `This usually means VITE_BACKEND_URL is empty or scheme-less, ` +
            `so the request hit the frontend instead of the backend. ` +
            `Got Content-Type: "${contentType}".`
        );
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error ?? `Backend returned ${res.status} from ${fetchUrl}`);
      }

      const data = (await res.json()) as ScrapeResult;
      clearTimers();
      setFinishedInMs(Date.now() - startedAtRef.current);
      setStepIndex(2);
      timersRef.current.push(
        setTimeout(() => {
          setStepIndex(3);
          timersRef.current.push(
            setTimeout(() => {
              setResult(data);
              setStatus("done");
              const videoId = data.video?.video_id;
              if (videoId) {
                setRecent(
                  saveRecentScrape({
                    videoId,
                    title: data.video?.title || videoId,
                    totalItems: data.summary?.total_items ?? 0,
                    timestamp: Date.now(),
                  })
                );
              }
            }, 250)
          );
        }, 250)
      );
    } catch (e) {
      clearTimers();
      const msg = e instanceof Error ? e.message : "Could not reach the server. Is it running?";
      setErrorMsg(msg);
      setLogLines((lines) => [...lines, `> error · ${msg}`]);
      setStatus("error");
    }
  };

  const retry = () => run();

  const reportIssue = async () => {
    const report = `URL: ${url}\nError: ${errorMsg}\nTime: ${new Date().toISOString()}`;
    try {
      await navigator.clipboard.writeText(report);
      setReportCopied(true);
      setTimeout(() => setReportCopied(false), 1600);
    } catch {
      // Clipboard API unavailable — nothing else to fall back to here.
    }
  };

  const jsonBlobSize = useMemo(() => {
    if (!result) return 0;
    return new Blob([JSON.stringify(result)]).size;
  }, [result]);

  const download = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    const safeTitle = (result.video?.title || result.video?.video_id || "comments")
      .replace(/[^a-z0-9]+/gi, "_")
      .slice(0, 60);
    link.download = `${safeTitle}_comments.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const buildCsv = (): string => {
    if (!result) return "";
    const sourceId = result.source_id ?? "";
    const slug = result.provenance?.client_slug ?? "";

    const header = [
      "client_slug",
      "source_id",
      "comment_id",
      "parent_id",
      "author",
      "text",
      "likes",
      "published_at",
      "is_reply",
    ];
    const rows: string[] = [header.join(",")];

    for (const comment of result.comments ?? []) {
      rows.push(
        [
          csvField(slug),
          csvField(sourceId),
          csvField(comment.comment_id),
          csvField(""),
          csvField(comment.author),
          csvField(comment.text),
          csvField(comment.likes ?? ""),
          csvField(comment.published_at),
          csvField(false),
        ].join(",")
      );
      for (const reply of comment.replies ?? []) {
        rows.push(
          [
            csvField(slug),
            csvField(sourceId),
            csvField(reply.reply_id),
            csvField(comment.comment_id),
            csvField(reply.author),
            csvField(reply.text),
            csvField(reply.likes ?? ""),
            csvField(reply.published_at),
            csvField(true),
          ].join(",")
        );
      }
    }

    return rows.join("\r\n");
  };

  const [csvCopied, setCsvCopied] = useState(false);
  const copyCsv = async () => {
    const csv = buildCsv();
    if (!csv) return;
    try {
      await navigator.clipboard.writeText(csv);
      setCsvCopied(true);
      setTimeout(() => setCsvCopied(false), 1600);
    } catch {
      // Clipboard API unavailable — fall back to a download.
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${result?.source_id || "scrape"}_comments.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    }
  };

  const reset = () => {
    clearTimers();
    setUrl("");
    setClientSlug("");
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
    setUrlInvalid(false);
  };

  const labelClass = "font-[600] text-[10px] tracking-[.2em] uppercase text-[#5b6573]";
  const monoField =
    "bg-[#0A0D12] border border-[#2c3540] rounded-[10px] text-[#E7EBF1] caret-[#B8F24A] font-['JetBrains_Mono']";

  return (
    <div className="min-h-screen bg-[#05070a] flex items-center justify-center p-6">
      <div className="w-full max-w-[600px]">
        <div
          className="bg-[#0E1218] border border-[#232b36] rounded-[14px] overflow-hidden text-[#E7EBF1]"
          style={{ boxShadow: "0 34px 70px -28px rgba(0,0,0,.7)", fontFamily: "'Space Grotesk', sans-serif" }}
        >
          {/* Title bar */}
          <div className="flex items-center gap-2 px-4 py-3 bg-[#0A0D12] border-b border-[#1a212b]">
            <span className="w-[11px] h-[11px] rounded-full bg-[#2a323d]" />
            <span className="w-[11px] h-[11px] rounded-full bg-[#2a323d]" />
            <span className="w-[11px] h-[11px] rounded-full bg-[#2a323d]" />
            <span className="ml-2 font-['JetBrains_Mono'] text-xs text-[#5b6573]">
              {status === "loading"
                ? "eccolo — scraping…"
                : status === "done"
                ? "eccolo — done"
                : status === "error"
                ? "eccolo — error"
                : "eccolo — ~/scrape"}
            </span>
          </div>

          <div className="p-[30px]">
            {/* Logo row */}
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-[10px]">
                <span
                  className={`w-[26px] h-[26px] rounded-[7px] bg-[#B8F24A] flex items-center justify-center text-[#0E1218] font-bold text-sm ${
                    status === "loading" ? "animate-[tl-soft_1.3s_ease-in-out_infinite]" : ""
                  }`}
                >
                  ⌁
                </span>
                <span className="font-['JetBrains_Mono'] font-semibold text-xs tracking-[.24em] text-[#aab3c0]">
                  ECCOLO
                </span>
              </div>
              {ANALYTICS_URL && (
                <a
                  href={analyticsLinkFor()}
                  target="_blank"
                  rel="noreferrer"
                  className="font-['JetBrains_Mono'] text-xs text-[#697483] hover:text-[#B8F24A]"
                >
                  Analytics ↗
                </a>
              )}
            </div>

            {status === "idle" && (
              <>
                <h1 className="m-0 mb-[10px] font-semibold text-[34px] leading-[1.04] tracking-[-0.02em]">
                  Paste a link
                  <span className="text-[#B8F24A] animate-[tl-blink_1.1s_step-end_infinite]">_</span>
                </h1>
                <p className="m-0 mb-[26px] font-['JetBrains_Mono'] text-sm text-[#7b8698]">
                  Threaded comments, replies &amp; metadata → one clean JSON.
                </p>

                <div className={`flex gap-[10px] ${urlInvalid ? "mb-2" : "mb-4"}`}>
                  <div
                    className={`flex-1 flex items-center gap-2 h-[50px] px-[14px] ${monoField} ${
                      urlInvalid ? "!border-[#ff6b5e]" : ""
                    }`}
                  >
                    <span className={`text-sm ${urlInvalid ? "text-[#ff6b5e]" : "text-[#4f5a6a]"}`}>▸</span>
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setUrlInvalid(false);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && run()}
                      placeholder="youtube.com/watch?v=…"
                      className="flex-1 bg-transparent outline-none text-sm placeholder:text-[#4f5a6a]"
                    />
                  </div>
                  <button
                    onClick={run}
                    disabled={!url.trim()}
                    className="h-[50px] px-[22px] rounded-[10px] bg-[#B8F24A] text-[#0E1218] font-bold text-sm disabled:bg-[#141b23] disabled:text-[#4f5a6a] disabled:cursor-not-allowed"
                  >
                    Scrape ↵
                  </button>
                </div>
                {urlInvalid && (
                  <p className="m-0 mb-4 font-['JetBrains_Mono'] text-xs text-[#ff6b5e]">
                    That doesn't look like a YouTube video URL.
                  </p>
                )}

                <div className="flex flex-wrap gap-2 mb-6">
                  {["youtube.com", "youtu.be", "/shorts", "/live"].map((chip) => (
                    <span
                      key={chip}
                      className="px-[11px] py-[6px] border border-[#283039] rounded-[7px] font-['JetBrains_Mono'] text-xs text-[#8a94a4]"
                    >
                      {chip}
                    </span>
                  ))}
                </div>

                <div className="mb-6">
                  <div className={`${labelClass} mb-2`}>
                    Client slug <span className="text-[#3f4854]">· optional</span>
                  </div>
                  <div className={`flex items-center h-[44px] px-[14px] ${monoField}`}>
                    <input
                      type="text"
                      value={clientSlug}
                      onChange={(e) => setClientSlug(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && run()}
                      placeholder="e.g. jameshoffmann"
                      className="flex-1 bg-transparent outline-none text-sm placeholder:text-[#4f5a6a]"
                    />
                  </div>
                </div>

                {recent.length > 0 && (
                  <div className="border-t border-[#1a212b] pt-[18px]">
                    <div className={`${labelClass} mb-[14px]`}>Recent</div>
                    {recent.slice(0, 2).map((r, i) => (
                      <div
                        key={r.videoId}
                        className={`flex items-center justify-between py-2 ${
                          i > 0 ? "border-t border-[#151b23]" : ""
                        }`}
                      >
                        <span className="font-['JetBrains_Mono'] text-[13px] text-[#c3cad4] truncate max-w-[360px]">
                          {r.title}
                        </span>
                        <span className="font-['JetBrains_Mono'] text-xs text-[#697483] shrink-0 ml-2">
                          {r.totalItems.toLocaleString()} · {timeAgo(r.timestamp)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {status === "loading" && (
              <>
                <div className="font-['JetBrains_Mono'] text-[13px] text-[#7b8698] mb-[6px]">
                  scraping comments…
                </div>
                <div className="flex items-end gap-2 mb-6">
                  <span className="font-semibold text-[52px] leading-[0.9] tracking-[-0.02em] text-white">
                    {elapsedSec}
                  </span>
                  <span className="font-['JetBrains_Mono'] text-sm text-[#8a94a4] pb-2">
                    sec elapsed
                  </span>
                  <span className="w-[3px] h-[34px] bg-[#B8F24A] mb-[10px] ml-[2px] animate-[tl-blink_1s_step-end_infinite]" />
                </div>

                <div className="relative h-2 rounded-full bg-[#1a212b] overflow-hidden mb-[10px]">
                  <div className="absolute inset-y-0 w-1/4 rounded-full bg-[#B8F24A] animate-[tl-loadbar_1.6s_linear_infinite]" />
                </div>
                <div className="flex justify-between font-['JetBrains_Mono'] text-[11px] text-[#697483] mb-7">
                  <span>working…</span>
                  <span>this can take a moment on big threads</span>
                </div>

                <div className="flex flex-col gap-[14px] mb-7">
                  {STEP_LABELS.map((label, i) => (
                    <div key={label} className="flex items-center gap-3">
                      {i < stepIndex ? (
                        <span className="w-[18px] h-[18px] rounded-full bg-[#B8F24A]/[0.16] text-[#B8F24A] flex items-center justify-center font-bold text-[11px]">
                          ✓
                        </span>
                      ) : i === stepIndex ? (
                        <span className="w-[18px] h-[18px] rounded-full border-2 border-[#283039] border-t-[#B8F24A] animate-[spin_0.8s_linear_infinite]" />
                      ) : (
                        <span className="w-[18px] h-[18px] rounded-full border-[1.5px] border-[#283039]" />
                      )}
                      <span
                        className={`font-['JetBrains_Mono'] text-[13px] ${
                          i === stepIndex ? "text-[#E7EBF1]" : i < stepIndex ? "text-[#9aa4b3]" : "text-[#5b6573]"
                        }`}
                      >
                        {label}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="bg-[#080b0f] border border-[#151b23] rounded-[10px] px-4 py-[14px] font-['JetBrains_Mono'] text-xs leading-[1.7]">
                  {logLines.map((line, i) => (
                    <div
                      key={i}
                      className={i === logLines.length - 1 ? "text-[#B8F24A]" : "text-[#697483]"}
                    >
                      {line}
                      {i === logLines.length - 1 && (
                        <span className="animate-[tl-blink_1s_step-end_infinite]">▋</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {status === "error" && (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-[40px] h-[40px] shrink-0 rounded-[11px] bg-[#ff6b5e]/[0.12] text-[#ff6b5e] flex items-center justify-center font-bold text-xl">
                    !
                  </span>
                  <span className="inline-flex items-center gap-[7px] px-[11px] py-[5px] rounded-full bg-[#ff6b5e]/[0.1] text-[#ff6b5e] font-['JetBrains_Mono'] font-bold text-[11px] tracking-[.1em]">
                    SCRAPE FAILED
                  </span>
                </div>
                <h1 className="m-0 mb-[10px] font-semibold text-[28px] leading-[1.1] tracking-[-0.02em]">
                  Couldn't scrape that link
                </h1>
                <p className="m-0 mb-[22px] font-['JetBrains_Mono'] text-sm leading-[1.55] text-[#7b8698]">
                  {errorMsg}
                </p>

                <div className="flex items-center gap-2 h-[46px] px-[14px] mb-[14px] bg-[#0A0D12] border border-[#2c3540] rounded-[10px]">
                  <span className="text-[#4f5a6a] text-sm">▸</span>
                  <span className="font-['JetBrains_Mono'] text-[13px] text-[#8b95a4] truncate">{url}</span>
                </div>
                <div className="bg-[#080b0f] border border-[#151b23] rounded-[10px] px-4 py-[14px] mb-[26px] font-['JetBrains_Mono'] text-xs leading-[1.7]">
                  {logLines.map((line, i) => (
                    <div key={i} className={i === logLines.length - 1 ? "text-[#ff6b5e]" : "text-[#697483]"}>
                      {line}
                    </div>
                  ))}
                </div>

                <div className={`${labelClass} mb-[14px]`}>Common causes</div>
                <div className="flex flex-col gap-[11px] mb-7 font-['JetBrains_Mono'] text-[13px] text-[#9aa4b3]">
                  <div className="flex gap-[10px]">
                    <span className="text-[#5b6573]">·</span> Comments disabled by the uploader
                  </div>
                  <div className="flex gap-[10px]">
                    <span className="text-[#5b6573]">·</span> Video is private, unlisted, or age-restricted
                  </div>
                  <div className="flex gap-[10px]">
                    <span className="text-[#5b6573]">·</span> Link is a channel or playlist, not a video
                  </div>
                </div>

                <button
                  onClick={reset}
                  className="w-full h-[52px] rounded-[11px] bg-[#B8F24A] text-[#0E1218] font-bold text-[15px] mb-3"
                >
                  Try another link
                </button>
                <div className="flex gap-[10px]">
                  <button
                    onClick={retry}
                    className="flex-1 h-[44px] border border-[#2c3540] rounded-[10px] text-[#aab3c0] font-['JetBrains_Mono'] font-semibold text-[13px]"
                  >
                    Retry
                  </button>
                  <button
                    onClick={reportIssue}
                    className="flex-1 h-[44px] border border-[#2c3540] rounded-[10px] text-[#aab3c0] font-['JetBrains_Mono'] font-semibold text-[13px]"
                  >
                    {reportCopied ? "Copied ✓" : "Report issue"}
                  </button>
                </div>
              </>
            )}

            {status === "done" && result && (() => {
              const perDay = commentsPerDay(result.comments);
              const maxDay = perDay ? Math.max(...perDay) : 0;
              const threads = topThreads(result.comments);
              const videoId = result.video?.video_id;
              const finishedLabel =
                finishedInMs != null ? `finished in ${(finishedInMs / 1000).toFixed(1)}s` : "";

              return (
                <>
                  <div className="flex items-center justify-between mb-6">
                    <span className="inline-flex items-center gap-[7px] px-[11px] py-[5px] rounded-full bg-[#B8F24A]/[0.12] text-[#B8F24A] font-['JetBrains_Mono'] font-bold text-[11px] tracking-[.1em]">
                      <span className="w-[6px] h-[6px] rounded-full bg-[#B8F24A]" />
                      COMPLETE
                    </span>
                    {finishedLabel && (
                      <span className="font-['JetBrains_Mono'] text-xs text-[#697483]">{finishedLabel}</span>
                    )}
                  </div>

                  <div className="flex gap-[14px] items-center mb-6">
                    {videoId ? (
                      <img
                        src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
                        alt=""
                        className="w-[104px] h-[58px] shrink-0 rounded-lg border border-[#232b35] object-cover"
                      />
                    ) : (
                      <div className="w-[104px] h-[58px] shrink-0 rounded-lg border border-[#232b35] bg-[#161c24]" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-[17px] leading-[1.25] tracking-[-0.01em] mb-1 truncate">
                        {result.video?.title || "Comments ready"}
                      </div>
                      <div className="font-['JetBrains_Mono'] text-[13px] text-[#7b8698] truncate">
                        {[
                          result.video?.channel,
                          result.video?.view_count
                            ? `${Number(result.video.view_count).toLocaleString()} views`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-[10px] mb-[26px]">
                    {[
                      ["COMMENTS", result.summary?.top_level_comments, false],
                      ["REPLIES", result.summary?.total_replies, false],
                      ["TOTAL", result.summary?.total_items, true],
                    ].map(([label, value, accent]) => (
                      <div
                        key={label as string}
                        className="flex-1 bg-[#0A0D12] border border-[#1c232d] rounded-[10px] p-[14px]"
                      >
                        <div
                          className={`font-semibold text-[26px] ${accent ? "text-[#B8F24A]" : "text-white"}`}
                        >
                          {((value as number) ?? 0).toLocaleString()}
                        </div>
                        <div className="font-['JetBrains_Mono'] text-[10px] tracking-[.12em] text-[#697483] mt-[6px]">
                          {label as string}
                        </div>
                      </div>
                    ))}
                  </div>

                  {perDay && (
                    <div className="mb-[26px]">
                      <div className={`${labelClass} mb-3`}>Comments / day · first 14d</div>
                      <div className="flex items-end gap-[5px] h-[60px]">
                        {perDay.map((count, i) => (
                          <span
                            key={i}
                            style={{
                              height: `${Math.max(4, (count / (maxDay || 1)) * 100)}%`,
                              background: barColor(count / (maxDay || 1)),
                            }}
                            className="flex-1 rounded-t-[2px]"
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {threads.length > 0 && (
                    <div className="mb-[26px]">
                      <div className={`${labelClass} mb-[14px]`}>Top threads</div>
                      {threads.map((c, i) => (
                        <div
                          key={c.comment_id}
                          className={`flex gap-[11px] py-[14px] ${
                            i < threads.length - 1 ? "border-b border-[#151b23]" : ""
                          }`}
                        >
                          <span className="w-[30px] h-[30px] shrink-0 rounded-full bg-[#1c2530] text-[#9aa4b3] flex items-center justify-center font-['JetBrains_Mono'] font-semibold text-[11px]">
                            {initials(c.author)}
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium text-[13px] leading-[1.45] text-[#d7dce3]">
                              {c.text}
                            </div>
                            <div className="flex items-center gap-[10px] mt-[5px] font-['JetBrains_Mono'] text-[11px] text-[#697483]">
                              <span className="text-[#7b8698]">
                                {c.author ? (c.author.startsWith("@") ? c.author : `@${c.author}`) : "@unknown"}
                              </span>
                              <span className="flex items-center gap-[5px]">
                                <span className="w-[6px] h-[6px] rounded-full bg-[#697483]" />
                                {(c.likes ?? 0).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={download}
                    className="w-full h-[52px] rounded-[11px] bg-[#B8F24A] text-[#0E1218] font-bold text-[15px] flex items-center justify-center gap-[9px] mb-3"
                  >
                    ↓ Download JSON{" "}
                    <span className="font-['JetBrains_Mono'] text-xs opacity-60">
                      · {formatBytes(jsonBlobSize)}
                    </span>
                  </button>
                  <div className="flex gap-[10px] mb-4">
                    <button
                      onClick={copyCsv}
                      className="flex-1 h-[44px] border border-[#2c3540] rounded-[10px] text-[#aab3c0] font-['JetBrains_Mono'] font-semibold text-[13px]"
                    >
                      {csvCopied ? "Copied ✓" : "Copy as CSV"}
                    </button>
                    <button
                      onClick={reset}
                      className="flex-1 h-[44px] border border-[#2c3540] rounded-[10px] text-[#aab3c0] font-['JetBrains_Mono'] font-semibold text-[13px]"
                    >
                      Scrape another
                    </button>
                  </div>
                  <button
                    onClick={() => onSendToAnalyzer(result)}
                    className="w-full text-center font-['JetBrains_Mono'] text-xs text-[#697483] hover:text-[#B8F24A]"
                  >
                    Send to Sentiment Analyzer →
                  </button>
                  {ANALYTICS_URL && (
                    <a
                      href={analyticsLinkFor(result.provenance?.client_slug)}
                      target="_blank"
                      rel="noreferrer"
                      className="w-full block text-center mt-2 font-['JetBrains_Mono'] text-xs text-[#697483] hover:text-[#B8F24A]"
                    >
                      View {result.provenance?.client_slug || "channel"} performance analytics →
                    </a>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {status !== "done" && (
          <p className="text-center mt-6">
            <button
              onClick={onGoToAnalyzerStandalone}
              className="font-['JetBrains_Mono'] text-xs text-[#697483] hover:text-[#B8F24A]"
            >
              Or analyze an existing comments export →
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
