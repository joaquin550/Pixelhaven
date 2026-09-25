"""Command line: scrape a URL straight into the library.

    python -m pixelhaven.cli https://www.pinterest.com/pin/123/ --max 10
"""

from __future__ import annotations

import argparse
import logging

from . import tagger
from .jobs import run_scrape
from .library import Library


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Scrape images from a URL into the Pixelhaven library")
    p.add_argument("urls", nargs="+")
    p.add_argument("--max", type=int, default=20, help="max images per URL (default 20)")
    p.add_argument("--js", action="store_true", help="render the page with headless Chromium first")
    args = p.parse_args()

    lib = Library()
    print(f"Library: {lib.root}  |  tagging: {'Claude ' + tagger.MODEL if tagger.ai_enabled() else 'basic (no API key)'}")
    for url in args.urls:
        print(f"\n> {url}")
        job = run_scrape(lib, url, max_images=args.max, render_js=args.js)
        for image_id in job.added:
            img = lib.get(image_id)
            print(f"  + {img['filename']}")
            print(f"      from {img['original_name']}  <{img['source_url']}>")
            print(f"      tags: {', '.join(img['tags'])}")
        print(f"  {job.message}")
        for err in job.errors:
            print(f"  ! {err}")


if __name__ == "__main__":
    main()
