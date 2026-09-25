"""Scrape jobs: find images at a URL, download, tag and store them."""

from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field

from . import scraper
from .library import Library, SkipImage

log = logging.getLogger(__name__)
WORKERS = 4


@dataclass
class Job:
    id: str
    url: str
    status: str = "queued"  # queued | finding | downloading | done | error
    message: str = ""
    found: int = 0
    processed: int = 0
    added: list[int] = field(default_factory=list)
    skipped: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def run_scrape(library: Library, url: str, max_images: int = 20, render_js: bool = False,
               job: Job | None = None) -> Job:
    job = job or Job(id=uuid.uuid4().hex[:12], url=url)
    try:
        job.status = "finding"
        result = scraper.find_images(url, render_js=render_js)
        cands = result.candidates
        # Pull extra candidates so filtered-out icons/duplicates don't eat the budget.
        pool = cands[: max_images * 3]
        job.found = len(cands)
        if not cands:
            job.status = "done"
            job.message = ("No images found. If this site needs JavaScript or a login "
                           "(Instagram often does), try 'Render JavaScript'.")
            return job

        job.status = "downloading"
        session = scraper._session()
        lock = threading.Lock()

        in_flight = 0  # images being tagged right now; counts toward max_images

        def process(cand: scraper.Candidate) -> None:
            nonlocal in_flight
            with lock:
                if len(job.added) + in_flight >= max_images:
                    return
            dl = scraper.download(cand, result.page_url, session)
            with lock:
                job.processed += 1
                if dl is None:
                    job.skipped += 1
                    return
                if len(job.added) + in_flight >= max_images:
                    return
                in_flight += 1
            try:
                img = library.add(dl.data, source_url=dl.url, original_name=dl.original_name,
                                  page_url=result.page_url, page_title=result.page_title, alt=dl.alt)
                with lock:
                    job.added.append(img["id"])
            except SkipImage:
                with lock:
                    job.skipped += 1
            except Exception as e:
                log.exception("Failed to add %s", cand.url)
                with lock:
                    job.errors.append(f"{cand.url}: {e}")
            finally:
                with lock:
                    in_flight -= 1

        with ThreadPoolExecutor(max_workers=WORKERS) as pool_exec:
            list(pool_exec.map(process, pool))

        job.status = "done"
        job.message = f"Added {len(job.added)} image(s), skipped {job.skipped} (duplicates, icons or broken)."
    except scraper.ScrapeError as e:
        job.status = "error"
        job.message = str(e)
    except Exception as e:
        log.exception("Scrape failed for %s", url)
        job.status = "error"
        job.message = f"Unexpected error: {e}"
    return job


class JobManager:
    def __init__(self, library: Library):
        self.library = library
        self.jobs: dict[str, Job] = {}

    def start(self, url: str, max_images: int = 20, render_js: bool = False) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], url=url)
        self.jobs[job.id] = job
        t = threading.Thread(target=run_scrape, args=(self.library, url, max_images, render_js, job), daemon=True)
        t.start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)
