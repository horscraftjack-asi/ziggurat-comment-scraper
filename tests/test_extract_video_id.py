"""URL-parsing tests for app.extract_video_id.

Every accepted YouTube surface funnels through this one regex before the Data API is
touched, so a form the regex misses is a hard 400 for the user even though the API would
have served the video fine. /shorts/ and /live/ were both silently unsupported until the
regex learned them, hence the explicit coverage below.
"""
import pytest

from app import extract_video_id

VID = "dQw4w9WgXcQ"


@pytest.mark.parametrize("url", [
    f"https://www.youtube.com/shorts/{VID}",
    f"https://youtube.com/shorts/{VID}",
    f"http://www.youtube.com/shorts/{VID}",
    f"www.youtube.com/shorts/{VID}",
    f"youtube.com/shorts/{VID}",
    f"https://www.youtube.com/shorts/{VID}?feature=share",
    f"https://m.youtube.com/shorts/{VID}",
])
def test_shorts_urls(url):
    assert extract_video_id(url) == VID


@pytest.mark.parametrize("url", [
    f"https://www.youtube.com/live/{VID}",
    f"https://youtube.com/live/{VID}",
    f"https://www.youtube.com/live/{VID}?si=abcdef",
])
def test_live_urls(url):
    assert extract_video_id(url) == VID


@pytest.mark.parametrize("url", [
    f"https://www.youtube.com/watch?v={VID}",
    f"https://www.youtube.com/watch?v={VID}&t=42s",
    f"https://youtu.be/{VID}",
    f"https://youtu.be/{VID}?t=42",
    f"https://www.youtube.com/embed/{VID}",
    f"https://www.youtube.com/v/{VID}",
    VID,
])
def test_previously_supported_forms_still_work(url):
    assert extract_video_id(url) == VID


@pytest.mark.parametrize("bad", [
    "",
    "https://www.youtube.com/",
    "https://www.youtube.com/shorts/",
    "https://vimeo.com/123456789",
    "not a url at all",
])
def test_unparseable_input_raises(bad):
    with pytest.raises(ValueError):
        extract_video_id(bad)
