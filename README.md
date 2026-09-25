# Pixelhaven

Paste a link, get a tagged image library.

Pixelhaven scrapes images from any link (a Pinterest pin, an Instagram post, a Google Images
search, a blog post, or a direct image URL), downloads them into a local library, and for each image:

- **keeps the original file name, the image URL and the page it was found on**
- **auto-tags it** with what is in the picture (subjects, objects, setting, style, mood, colours, visible text)
- **renames it** to a descriptive file name, e.g. `IMG_4821.jpg` becomes `red-panda-sleeping-on-branch-3f9a1c2e.jpg`
- writes a short title and description so you can search for it later
- skips duplicates (by content hash), tiny icons and broken files

Tagging uses Claude's vision model when an Anthropic API key is set. Without a key, a basic
tagger still adds orientation, dominant colours, resolution and source-site tags.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium          # optional, only for "Render JavaScript"

export ANTHROPIC_API_KEY=sk-ant-...  # optional, enables AI tags and names
python -m pixelhaven                 # open http://127.0.0.1:5000
```

In the web app:

1. Paste a link and press **Scrape**. Tick **Render JavaScript** for pages that build their images
   with JavaScript (infinite-scroll boards, some search pages).
2. Browse the library, search by any word, or click tag chips to filter.
3. Open an image to see its original name and source links, edit tags, title or file name,
   re-run AI tagging, download or delete it.
4. **Export JSON** downloads all metadata.

### Command line

```bash
python -m pixelhaven.cli "https://www.pinterest.com/pin/123456/" --max 10
python -m pixelhaven.cli URL1 URL2 --js       # render with headless Chromium first
```

## Where things are stored

```
data/
  images/        the image files, with their new names
  library.db     SQLite: original name, source URL, page URL, title, description, tags, size, hash
```

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Enables Claude tagging and naming |
| `PIXELHAVEN_MODEL` | `claude-opus-5` | Claude model used for tagging |
| `PIXELHAVEN_DISABLE_AI` | unset | Set to `1` to force basic tagging |
| `PIXELHAVEN_DATA` | `./data` | Library location |
| `PIXELHAVEN_MIN_SIDE` | `150` | Skip images smaller than this (px) |
| `PIXELHAVEN_CHROMIUM` | unset | Path to a Chrome/Chromium binary for JS rendering |

## How scraping works

For a web page Pixelhaven collects, best first:

1. Open Graph / Twitter card images (the main image of a pin or post)
2. JSON-LD structured data
3. `<img>` and `<source>` tags, taking the largest `srcset` entry and lazy-load attributes
4. image URLs embedded in page scripts, which is where Google Images, Pinterest and Instagram
   keep most of their data

Known thumbnail URLs are upgraded to full size (Pinterest `236x` to `originals`, Google
`=w200` to `=s0`).

### Limits worth knowing

- **Instagram** only shows public post images to logged-out visitors, and sometimes not even
  those. Single public post links work best. Private accounts and most profile grids will not.
- **Google Images** results are mostly thumbnails unless you open a result first.
- Sites change their markup and may rate-limit or block scrapers. Respect each site's terms and
  the image owners' copyright; this tool is meant for personal reference libraries.

## Development

```bash
pip install pytest
python -m pytest
```
