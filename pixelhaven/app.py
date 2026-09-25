"""Pixelhaven web app."""

from __future__ import annotations

import logging

from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory

from . import tagger
from .jobs import JobManager
from .library import Library


def create_app(library: Library | None = None) -> Flask:
    app = Flask(__name__)
    lib = library or Library()
    jobs = JobManager(lib)
    app.config["LIBRARY"] = lib

    @app.get("/")
    def index():
        return render_template("index.html", ai=tagger.ai_enabled(), model=tagger.MODEL)

    @app.get("/image/<int:image_id>")
    def detail(image_id: int):
        img = lib.get(image_id)
        if not img:
            abort(404)
        return render_template("detail.html", img=img)

    @app.get("/files/<path:filename>")
    def files(filename: str):
        return send_from_directory(lib.images_dir, filename)

    # ---------------------------------------------------------------- API

    @app.post("/api/scrape")
    def api_scrape():
        body = request.get_json(silent=True) or request.form
        url = (body.get("url") or "").strip()
        if not url:
            return jsonify(error="url is required"), 400
        try:
            max_images = max(1, min(int(body.get("max_images") or 20), 200))
        except ValueError:
            max_images = 20
        render_js = str(body.get("render_js", "")).lower() in ("1", "true", "on", "yes")
        job = jobs.start(url, max_images=max_images, render_js=render_js)
        return jsonify(job.to_dict()), 202

    @app.get("/api/jobs/<job_id>")
    def api_job(job_id: str):
        job = jobs.get(job_id)
        if not job:
            return jsonify(error="unknown job"), 404
        return jsonify(job.to_dict())

    @app.get("/api/images")
    def api_images():
        q = request.args.get("q", "")
        tags = [t for t in request.args.getlist("tag") if t]
        limit = min(int(request.args.get("limit", 200)), 1000)
        offset = int(request.args.get("offset", 0))
        return jsonify(images=lib.search(q, tags, limit, offset), total=lib.count())

    @app.get("/api/tags")
    def api_tags():
        return jsonify(tags=[{"tag": t, "count": n} for t, n in lib.tag_counts()])

    @app.get("/api/images/<int:image_id>")
    def api_image(image_id: int):
        img = lib.get(image_id)
        return jsonify(img) if img else (jsonify(error="not found"), 404)

    @app.patch("/api/images/<int:image_id>")
    def api_update(image_id: int):
        if not lib.get(image_id):
            return jsonify(error="not found"), 404
        body = request.get_json(silent=True) or {}
        if "tags" in body:
            tags = body["tags"]
            if isinstance(tags, str):
                tags = tags.split(",")
            lib.set_tags(image_id, tags)
        lib.update(image_id, **{k: body[k] for k in ("title", "description") if k in body})
        if body.get("name"):
            try:
                lib.rename(image_id, body["name"])
            except ValueError as e:
                return jsonify(error=str(e)), 400
        return jsonify(lib.get(image_id))

    @app.post("/api/images/<int:image_id>/retag")
    def api_retag(image_id: int):
        img = lib.retag(image_id)
        return jsonify(img) if img else (jsonify(error="not found"), 404)

    @app.delete("/api/images/<int:image_id>")
    def api_delete(image_id: int):
        return ("", 204) if lib.delete(image_id) else (jsonify(error="not found"), 404)

    @app.get("/api/export.json")
    def api_export():
        return Response(lib.export_json(), mimetype="application/json",
                        headers={"Content-Disposition": "attachment; filename=pixelhaven-library.json"})

    return app


def main() -> None:
    import argparse
    import os

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(description="Run the Pixelhaven web app")
    # Hosts like Replit/Render pass HOST/PORT in the environment.
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)))
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()
    create_app().run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
