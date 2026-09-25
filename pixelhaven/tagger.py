"""Auto-tagging and naming for images.

If ANTHROPIC_API_KEY (or another Anthropic credential) is available, Claude
looks at each image and returns a title, description, content tags and a
descriptive filename. Without it, a basic local tagger still adds tags for
orientation, dominant colours, resolution and source site.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from PIL import Image
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

MODEL = os.environ.get("PIXELHAVEN_MODEL", "claude-opus-5")
MAX_SIDE = 1568  # Claude downsizes anything larger anyway; saves upload + tokens


@dataclass
class Analysis:
    title: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    suggested_name: str = ""
    tagged_by: str = "basic"


class ClaudeTags(BaseModel):
    title: str = Field(description="Short human title for the image, max 8 words")
    description: str = Field(description="One or two sentences describing what is in the image")
    tags: list[str] = Field(
        description=(
            "10-25 lowercase tags covering subjects, objects, people (no identities), setting, "
            "style/medium, mood, colours, and any visible text or brands"
        )
    )
    filename: str = Field(description="Descriptive kebab-case filename without extension, 3-6 words")


PROMPT = """You are cataloguing images for a personal image library.
Look at the image and describe it so it can be found later by searching tags.

Context from where it was scraped (may be empty or unhelpful):
- Source page: {page_url}
- Page title: {page_title}
- Alt text: {alt}

Tags should be single words or short phrases, lowercase, no '#'. Do not identify real people by name
unless their name is clearly written in the image or in the context above."""


# ---------------------------------------------------------------- helpers

def slugify(text: str, max_words: int = 8) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    words = [w for w in text.split("-") if w][:max_words]
    return "-".join(words)


def normalize_tags(tags) -> list[str]:
    out, seen = [], set()
    for t in tags:
        t = re.sub(r"\s+", " ", str(t).strip().lower().lstrip("#"))
        t = t.strip(" .,;:")
        if t and len(t) <= 40 and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _prepare_for_claude(img: Image.Image) -> tuple[str, str]:
    """Return (media_type, base64) of a resized JPEG/PNG version of the image."""
    img = img.copy()
    if getattr(img, "is_animated", False):
        img.seek(0)
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        img.save(buf, format="PNG", optimize=True)
        media = "image/png"
    else:
        img.convert("RGB").save(buf, format="JPEG", quality=88)
        media = "image/jpeg"
    return media, base64.standard_b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------- basic tagger

_COLOR_NAMES = {
    "black": (20, 20, 20), "white": (240, 240, 240), "gray": (128, 128, 128),
    "red": (200, 40, 40), "orange": (240, 140, 30), "yellow": (240, 220, 50),
    "green": (60, 160, 60), "teal": (30, 140, 140), "blue": (40, 90, 200),
    "purple": (130, 60, 170), "pink": (240, 130, 180), "brown": (120, 80, 40),
    "beige": (220, 200, 160),
}


def _nearest_color(rgb) -> str:
    return min(_COLOR_NAMES, key=lambda n: sum((a - b) ** 2 for a, b in zip(rgb, _COLOR_NAMES[n])))


def dominant_colors(img: Image.Image, n: int = 3) -> list[str]:
    small = img.convert("RGB").resize((64, 64))
    pal = small.quantize(colors=6).convert("RGB")
    counts = sorted(pal.getcolors(64 * 64) or [], reverse=True)
    names = []
    for _, rgb in counts:
        name = _nearest_color(rgb)
        if name not in names:
            names.append(name)
        if len(names) >= n:
            break
    return names


def basic_tags(img: Image.Image, source_url: str, page_url: str) -> list[str]:
    w, h = img.size
    tags = []
    ratio = w / h if h else 1
    tags.append("landscape" if ratio > 1.15 else "portrait" if ratio < 0.87 else "square")
    if max(w, h) >= 3000:
        tags.append("high resolution")
    elif max(w, h) < 500:
        tags.append("low resolution")
    if getattr(img, "is_animated", False):
        tags.append("animated")
    if img.mode in ("RGBA", "LA") or "transparency" in img.info:
        tags.append("transparent")
    tags += dominant_colors(img)
    for url in (page_url, source_url):
        host = urlparse(url).netloc.lower().removeprefix("www.")
        for site in ("instagram", "pinterest", "google", "unsplash", "flickr", "reddit", "tumblr", "behance"):
            if site in host:
                tags.append(site)
    return normalize_tags(tags)


# ---------------------------------------------------------------- main entry

_client = None


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic()
    return _client


def ai_enabled() -> bool:
    if os.environ.get("PIXELHAVEN_DISABLE_AI"):
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def analyze(img: Image.Image, source_url: str = "", page_url: str = "", page_title: str = "", alt: str = "") -> Analysis:
    base = basic_tags(img, source_url, page_url)
    result = Analysis(tags=base, title=alt or page_title)

    if not ai_enabled():
        return result

    try:
        import anthropic

        media, data = _prepare_for_claude(img)
        response = _get_client().messages.parse(
            model=MODEL,
            max_tokens=4000,
            output_config={"effort": "low"},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}},
                    {"type": "text", "text": PROMPT.format(
                        page_url=page_url or "-", page_title=page_title or "-", alt=alt or "-")},
                ],
            }],
            output_format=ClaudeTags,
        )
        if response.stop_reason == "refusal" or response.parsed_output is None:
            log.warning("Claude declined to tag %s; using basic tags", source_url)
            return result
        parsed: ClaudeTags = response.parsed_output
        result.title = parsed.title.strip()
        result.description = parsed.description.strip()
        result.tags = normalize_tags(list(parsed.tags) + base)
        result.suggested_name = slugify(parsed.filename)
        result.tagged_by = MODEL
    except anthropic.APIStatusError as e:
        log.warning("Claude API error (%s) while tagging %s: %s", e.status_code, source_url, e)
    except anthropic.APIConnectionError as e:
        log.warning("Could not reach Claude API while tagging %s: %s", source_url, e)
    except Exception as e:  # never lose an image because tagging failed
        log.warning("Tagging failed for %s: %s", source_url, e)
    return result
