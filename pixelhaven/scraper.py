"""Find and download images from a URL.

Works on direct image links and on regular web pages. For pages it collects
images from Open Graph / Twitter meta tags, <img> tags (src, srcset, lazy-load
attributes), JSON-LD, and image URLs embedded in inline scripts, which is how
Instagram, Pinterest and Google Images ship most of their data.

Sites that need JavaScript can be rendered with Playwright (optional).
"""

from __future__ import annotations

import html
import json
import os
import re
from dataclasses import dataclass, field
from typing import Iterable
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 20
MAX_IMAGE_BYTES = 40 * 1024 * 1024
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tiff", ".tif")

# Absolute image URLs inside scripts / JSON blobs. Handles JSON escaping
# ("\/", "&", "\x3d") which Google and Instagram use heavily.
_SCRIPT_IMG_RE = re.compile(
    r"""https?:(?:\\?/){2}[^\s"'<>()]+?\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s"'<>\\]*)?""",
    re.IGNORECASE,
)
# CDN hosts whose URLs often have no file extension.
_CDN_RE = re.compile(
    r"""https?:(?:\\?/){2}(?:[a-z0-9-]+\.)*(?:cdninstagram\.com|fbcdn\.net|pinimg\.com|"""
    r"""googleusercontent\.com|gstatic\.com/images|encrypted-tbn\d\.gstatic\.com)[^\s"'<>\\]*""",
    re.IGNORECASE,
)
_JUNK_RE = re.compile(
    r"(sprite|favicon|logo|icon|avatar|emoji|blank|spacer|pixel|tracking|badge|/static/images/|"
    r"profile_pic|s150x150|/rsrc\.php)",
    re.IGNORECASE,
)


@dataclass
class Candidate:
    url: str
    alt: str = ""
    priority: int = 0  # higher = more likely the "main" image


@dataclass
class Download:
    url: str
    page_url: str
    data: bytes
    content_type: str
    original_name: str
    alt: str = ""


@dataclass
class ScrapeResult:
    page_url: str
    page_title: str = ""
    candidates: list[Candidate] = field(default_factory=list)


class ScrapeError(Exception):
    pass


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def _clean(url: str) -> str:
    url = url.strip()
    url = url.replace("\\/", "/")
    url = re.sub(r"\\u00([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), url)
    url = re.sub(r"\\x([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), url)
    return html.unescape(url)


def _upgrade(url: str) -> str:
    """Swap known thumbnail URLs for their full-size version."""
    host = urlparse(url).netloc
    if "pinimg.com" in host:
        return re.sub(r"pinimg\.com/\d+x\d*(?:_RS)?/", "pinimg.com/originals/", url)
    if "googleusercontent.com" in host:
        # =w200-h200 style size suffixes; =s0 means original size
        return re.sub(r"=(?:[swh]\d+[-a-z0-9]*)$", "=s0", url)
    return url


def _best_from_srcset(srcset: str) -> str | None:
    best, best_w = None, -1.0
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        w = 0.0
        if len(bits) > 1:
            m = re.match(r"([\d.]+)[wx]", bits[1])
            if m:
                w = float(m.group(1))
        if w > best_w:
            best, best_w = bits[0], w
    return best


def looks_like_image_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return path.endswith(IMAGE_EXTENSIONS)


def extract_candidates(page_html: str, page_url: str) -> ScrapeResult:
    soup = BeautifulSoup(page_html, "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    og_title = soup.find("meta", property="og:title")
    if og_title and og_title.get("content"):
        title = og_title["content"].strip()

    found: list[Candidate] = []

    def add(url: str | None, alt: str = "", priority: int = 0) -> None:
        if not url:
            return
        url = _clean(url)
        if url.startswith("data:") or url.startswith("blob:"):
            return
        found.append(Candidate(urljoin(page_url, url), alt.strip(), priority))

    # 1. Meta tags: usually the main image of a post/pin.
    for key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"):
        for tag in soup.find_all("meta", attrs={"property": key}) + soup.find_all("meta", attrs={"name": key}):
            add(tag.get("content"), title, 100)
    for tag in soup.find_all("link", rel=lambda r: r and "image_src" in r):
        add(tag.get("href"), title, 90)

    # 2. JSON-LD
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (ValueError, TypeError):
            continue
        for url in _jsonld_images(data):
            add(url, title, 80)

    # 3. <img> / <source> tags
    for img in soup.find_all(["img", "source"]):
        alt = img.get("alt", "") or img.get("title", "")
        srcset = img.get("srcset") or img.get("data-srcset")
        if srcset:
            add(_best_from_srcset(srcset), alt, 50)
        for attr in ("data-src", "data-original", "data-lazy-src", "data-iurl", "src"):
            if img.get(attr):
                add(img[attr], alt, 40)
                break

    # 4. URLs embedded in scripts (Google Images, Instagram, Pinterest JSON).
    for script in soup.find_all("script"):
        text = script.string or script.get_text() or ""
        if not text or len(text) < 20:
            continue
        for m in _SCRIPT_IMG_RE.finditer(text):
            add(m.group(0), "", 20)
        for m in _CDN_RE.finditer(text):
            add(m.group(0), "", 15)

    return ScrapeResult(page_url=page_url, page_title=title, candidates=_dedupe(found))


def _jsonld_images(data) -> Iterable[str]:
    if isinstance(data, list):
        for item in data:
            yield from _jsonld_images(item)
    elif isinstance(data, dict):
        for key in ("image", "thumbnailUrl", "contentUrl"):
            val = data.get(key)
            if isinstance(val, str):
                yield val
            elif isinstance(val, dict) and isinstance(val.get("url"), str):
                yield val["url"]
            elif isinstance(val, list):
                for v in val:
                    if isinstance(v, str):
                        yield v
                    elif isinstance(v, dict) and isinstance(v.get("url"), str):
                        yield v["url"]
        if "@graph" in data:
            yield from _jsonld_images(data["@graph"])


def _dedupe(cands: list[Candidate]) -> list[Candidate]:
    best: dict[str, Candidate] = {}
    for c in cands:
        url = _upgrade(c.url)
        if not url.startswith(("http://", "https://")):
            continue
        if _JUNK_RE.search(url) or url.lower().endswith(".svg"):
            continue
        key = url.split("#")[0]
        prev = best.get(key)
        if prev is None or c.priority > prev.priority:
            best[key] = Candidate(key, c.alt or (prev.alt if prev else ""), c.priority)
        elif not prev.alt and c.alt:
            prev.alt = c.alt
    return sorted(best.values(), key=lambda c: -c.priority)


def render_with_browser(url: str, scrolls: int = 4) -> str:
    """Render a page with headless Chromium (for JS-heavy sites)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:  # pragma: no cover
        raise ScrapeError("Playwright is not installed. Run: pip install playwright") from e

    with sync_playwright() as p:
        try:
            # PIXELHAVEN_CHROMIUM lets you point at an existing Chrome/Chromium binary.
            browser = p.chromium.launch(headless=True,
                                        executable_path=os.environ.get("PIXELHAVEN_CHROMIUM") or None)
        except Exception as e:
            raise ScrapeError(
                "Could not start headless Chromium. Run `playwright install chromium` "
                "or set PIXELHAVEN_CHROMIUM to a Chrome binary.") from e
        try:
            page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1366, "height": 900})
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            for _ in range(scrolls):
                page.mouse.wheel(0, 2500)
                page.wait_for_timeout(800)
            return page.content()
        finally:
            browser.close()


def find_images(url: str, render_js: bool = False) -> ScrapeResult:
    """Return image candidates found at `url` (best first)."""
    if not urlparse(url).scheme:
        url = "https://" + url
    session = _session()

    if render_js:
        return extract_candidates(render_with_browser(url), url)

    try:
        resp = session.get(url, timeout=TIMEOUT, allow_redirects=True)
    except requests.RequestException as e:
        raise ScrapeError(f"Could not fetch {url}: {e}") from e
    if resp.status_code >= 400:
        raise ScrapeError(f"{url} returned HTTP {resp.status_code}")

    ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if ctype.startswith("image/"):
        return ScrapeResult(page_url=url, candidates=[Candidate(resp.url, "", 1000)])
    return extract_candidates(resp.text, resp.url)


def original_name_from_url(url: str) -> str:
    path = unquote(urlparse(url).path)
    name = path.rstrip("/").rsplit("/", 1)[-1]
    return name or urlparse(url).netloc


def download(cand: Candidate, page_url: str, session: requests.Session | None = None) -> Download | None:
    session = session or _session()
    try:
        resp = session.get(
            cand.url,
            timeout=TIMEOUT,
            stream=True,
            headers={"Referer": page_url, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"},
        )
    except requests.RequestException:
        return None
    if resp.status_code >= 400:
        return None
    ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if ctype and not ctype.startswith("image/") and ctype != "application/octet-stream":
        return None
    if ctype == "image/svg+xml":
        return None

    chunks, size = [], 0
    for chunk in resp.iter_content(64 * 1024):
        size += len(chunk)
        if size > MAX_IMAGE_BYTES:
            return None
        chunks.append(chunk)

    # Prefer the filename the server gives us, fall back to the URL path.
    name = original_name_from_url(resp.url)
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd)
    if m:
        name = unquote(m.group(1))

    return Download(
        url=cand.url,
        page_url=page_url,
        data=b"".join(chunks),
        content_type=ctype,
        original_name=name,
        alt=cand.alt,
    )
