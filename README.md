# Chess Stats Dashboard

A small static website that shows a chess player's ratings, ranking and
tournament history by reading their profile page on
[chess.org.il](https://www.chess.org.il) live in the browser.

Default player: [Id=207079](https://www.chess.org.il/Players/Player.aspx?Id=207079).
Any numeric Israeli Chess Federation player ID can be loaded from the header.

## How it works

The Israeli Chess Federation site does not expose a public JSON API, so the
page is fetched directly in the browser as HTML through a public CORS proxy
(with automatic fallback across several proxies), then parsed with
`DOMParser`:

- `app.js` resolves label/value pairs (Hebrew and English) to get name,
  FIDE ID, club, ratings and ranking.
- It scores every `<table>` on the page and picks the one that looks most
  like a tournament history (rows, dates, typical Hebrew/English headers).

Because parsing is heuristic, a `Debug · raw extracted data` section at the
bottom of the page shows what was picked up so mismatches are easy to spot.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repository **Settings → Pages**, set:
   - **Source:** `Deploy from a branch`
   - **Branch:** `main` (or whichever branch holds these files) · `/ (root)`
3. Wait for the first deploy; the site will be served at
   `https://<user>.github.io/<repo>/`.

A `.nojekyll` file is included so GitHub Pages serves the files as-is.

## Notes

- This project is unofficial and not affiliated with the Israeli Chess
  Federation.
- Public CORS proxies can rate-limit or go down. If loading fails, the app
  tries multiple proxies in order; reloading a minute later usually works.
