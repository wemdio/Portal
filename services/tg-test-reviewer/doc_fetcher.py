import re
import logging
import httpx

logger = logging.getLogger(__name__)

GDOC_PATTERN = re.compile(r"https?://docs\.google\.com/document/d/([a-zA-Z0-9_-]+)")


def extract_google_doc_url(text: str) -> str | None:
    if not text:
        return None
    match = GDOC_PATTERN.search(text)
    if match:
        return f"https://docs.google.com/document/d/{match.group(1)}"
    return None


def _extract_doc_id(url: str) -> str:
    match = GDOC_PATTERN.search(url)
    if match:
        return match.group(1)
    raise ValueError(f"Invalid Google Doc URL: {url}")


async def fetch_google_doc(url: str) -> tuple[bool, str]:
    """Fetch Google Doc content as plain text.

    Returns (success, content_or_error).
    """
    doc_id = _extract_doc_id(url)
    export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"

    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        try:
            resp = await client.get(export_url)

            if any("accounts.google.com" in str(r.url) for r in resp.history):
                return False, "no_access"

            if resp.status_code == 200:
                content_type = resp.headers.get("content-type", "")
                text = resp.text.strip()

                if "text/plain" in content_type and len(text) > 50:
                    return True, text

                if "<html" in text[:200].lower():
                    return False, "no_access"

                if len(text) < 50:
                    return False, "empty_doc"

                return True, text

            if resp.status_code in (401, 403):
                return False, "no_access"
            if resp.status_code == 404:
                return False, "not_found"

            return False, "error"

        except httpx.TimeoutException:
            return False, "timeout"
        except Exception as e:
            logger.error(f"Error fetching doc {doc_id}: {e}")
            return False, "error"
