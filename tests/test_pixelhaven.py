import io
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from pixelhaven import scraper, tagger
from pixelhaven.app import create_app
from pixelhaven.jobs import run_scrape
from pixelhaven.library import Library, SkipImage


def make_png(color, size=(400, 300)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.setenv("PIXELHAVEN_DISABLE_AI", "1")


@pytest.fixture
def site(tmp_path):
    (tmp_path / "hero.png").write_bytes(make_png("red", (800, 600)))
    (tmp_path / "big.png").write_bytes(make_png("blue", (1200, 800)))
    (tmp_path / "small.png").write_bytes(make_png("green", (300, 300)))
    (tmp_path / "embedded.png").write_bytes(make_png("yellow", (500, 700)))
    (tmp_path / "icon.png").write_bytes(make_png("black", (32, 32)))
    (tmp_path / "dupe.png").write_bytes(make_png("red", (800, 600)))
    (tmp_path / "index.html").write_text("""
      <html><head><title>Test page</title>
        <meta property="og:image" content="/hero.png">
      </head><body>
        <img src="/small.png" srcset="/small.png 300w, /big.png 1200w" alt="A blue thing">
        <img data-src="/icon.png">
        <img src="/dupe.png">
        <script>var d = {"url":"http:\\/\\/HOST\\/embedded.png"};</script>
      </body></html>""")
    handler = partial(SimpleHTTPRequestHandler, directory=str(tmp_path))
    handler.log_message = lambda *a: None
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    host = f"127.0.0.1:{server.server_port}"
    html = (tmp_path / "index.html").read_text().replace("HOST", host)
    (tmp_path / "index.html").write_text(html)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://{host}"
    server.shutdown()


def test_extract_candidates(site):
    res = scraper.find_images(site + "/index.html")
    urls = [c.url for c in res.candidates]
    assert res.page_title == "Test page"
    assert urls[0] == site + "/hero.png"  # og:image ranks first
    assert site + "/big.png" in urls  # best srcset entry
    assert site + "/embedded.png" in urls  # JSON-escaped URL in script
    assert not any("icon" in u for u in urls)  # junk filter


def test_upgrade_pinterest_thumbnail():
    c = scraper._dedupe([scraper.Candidate("https://i.pinimg.com/236x/ab/cd/ef.jpg")])
    assert c[0].url == "https://i.pinimg.com/originals/ab/cd/ef.jpg"


def test_scrape_into_library(site, tmp_path):
    lib = Library(tmp_path / "lib")
    job = run_scrape(lib, site + "/index.html", max_images=10)
    assert job.status == "done", job.message
    images = lib.search()
    names = {i["original_name"] for i in images}
    # icon is too small; hero.png and dupe.png are identical so only one is kept
    assert names - {"hero.png", "dupe.png"} == {"big.png", "small.png", "embedded.png"}
    assert len(images) == 4
    hero = next(i for i in images if i["original_name"] in ("hero.png", "dupe.png"))
    assert hero["source_url"] == site + "/" + hero["original_name"]
    assert hero["page_url"] == site + "/index.html"
    assert "red" in hero["tags"] and "landscape" in hero["tags"]
    assert hero["filename"].endswith(".png") and hero["filename"] != "hero.png"
    assert (lib.images_dir / hero["filename"]).exists()
    assert [i["id"] for i in lib.search(tags=["portrait"])] == [
        i["id"] for i in images if i["original_name"] == "embedded.png"]


def test_max_images_respected(site, tmp_path):
    lib = Library(tmp_path / "lib")
    job = run_scrape(lib, site + "/index.html", max_images=2)
    assert len(job.added) == 2 and lib.count() == 2


def test_direct_image_link(site, tmp_path):
    lib = Library(tmp_path / "lib")
    job = run_scrape(lib, site + "/big.png")
    assert len(job.added) == 1


def test_duplicate_rejected(tmp_path):
    lib = Library(tmp_path / "lib")
    data = make_png("purple")
    lib.add(data, "http://x/a.png", "a.png")
    with pytest.raises(SkipImage):
        lib.add(data, "http://x/b.png", "b.png")


def test_ai_result_used_for_name_and_tags(tmp_path, monkeypatch):
    monkeypatch.setattr(tagger, "analyze", lambda img, **kw: tagger.Analysis(
        title="Cat on sofa", description="A cat.", tags=["cat", "sofa"],
        suggested_name="tabby-cat-on-sofa", tagged_by="claude-test"))
    lib = Library(tmp_path / "lib")
    img = lib.add(make_png("orange"), "http://x/IMG_1234.png", "IMG_1234.png")
    assert img["filename"].startswith("tabby-cat-on-sofa-")
    assert img["original_name"] == "IMG_1234.png"
    assert img["tags"] == ["cat", "sofa"]


def test_api(tmp_path):
    lib = Library(tmp_path / "lib")
    img = lib.add(make_png("teal"), "http://x/pic.png", "pic.png", page_url="http://x/")
    client = create_app(lib).test_client()
    assert client.get("/").status_code == 200
    assert client.get(f"/image/{img['id']}").status_code == 200
    assert client.get(f"/files/{img['filename']}").status_code == 200
    r = client.patch(f"/api/images/{img['id']}", json={"tags": "Beach, #sunset", "name": "My Beach Pic"})
    body = r.get_json()
    assert body["tags"] == ["beach", "sunset"]
    assert body["filename"].startswith("my-beach-pic-")
    assert client.get("/api/images?tag=beach").get_json()["images"][0]["id"] == img["id"]
    assert client.get("/api/images?q=beach").get_json()["images"]
    assert client.delete(f"/api/images/{img['id']}").status_code == 204
    assert lib.count() == 0
