# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static, no-build single-page site that renders a chess player's profile from
**two** sources in parallel:

- [chess.org.il](https://www.chess.org.il) (Israeli Chess Federation, ICF) —
  scraped HTML, no public API.
- [chess.com public API](https://www.chess.com/news/view/published-data-api) —
  JSON, CORS-enabled, no proxy needed.

Three files: `index.html`, `app.js`, `styles.css`. Deployed to GitHub Pages;
`.nojekyll` keeps Pages from processing the files.

## Running locally

No package manager, no build, no test suite. Open `index.html` directly, or:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

Defaults: ICF ID `207079`, chess.com username `silverbullet20000`. Both inputs
live in the header and are persisted in the URL hash
(`#id=12345&user=someone`), which `app.js` reads on `DOMContentLoaded`. Either
field can be left blank to load from only one source.

## Architecture

Everything worth knowing lives in `app.js`. The app runs entirely in the
browser; there is no backend. `load()` kicks off `loadIcf()` and
`loadChessCom()` in parallel via `Promise.all`, each wrapped so one source's
failure does not block rendering of the other — errors surface as per-section
`.section-status` messages rather than a global failure.

**ICF — CORS proxy fallback chain (`PROXIES` in app.js).** chess.org.il has
no JSON API and sets no CORS headers, so `loadIcf()` walks a list of public
raw-passthrough proxies in order, accepting the first response that is
non-empty and ≥500 bytes. When editing this list, every entry must return the
*raw body* of the target URL (not a JSON wrapper). Public proxies rate-limit
and disappear; the fallback is load-bearing, not belt-and-suspenders.

**chess.com — direct fetch, no proxy.** `loadChessCom()` hits
`https://api.chess.com/pub/player/{user}` and `/stats` in parallel. The `/pub/*`
namespace is CORS-enabled, usernames are lowercased, and the `country` field
is a URL that resolves to `{code, name}`. If chess.com ever breaks CORS, the
simplest fix is to route through the existing `PROXIES` chain.

**Heuristic HTML parsing.** The ICF site is ASP.NET WebForms with Hebrew + English
labels, so parsing is deliberately fuzzy:

- `extractLabelledFields` runs two strategies in parallel and merges results:
  (A) two-cell `<tr>` rows treated as label/value pairs, and (B) ASP.NET
  `<span id="...lblX">` values stored under an underscore-prefixed key (`_X`)
  so they don't collide with human-readable labels from strategy A.
- `LABEL_ALIASES` is the single source of truth mapping canonical field names
  (`standard`, `fideId`, `club`, …) to the Hebrew + English + `_`-prefixed
  aliases they may appear under. When adding a new field, extend this map
  rather than adding ad-hoc lookups elsewhere.
- `resolveField` tries exact match → case-insensitive → substring, in that
  order. Preserve this ordering; partial match is the last resort because it
  can pick up unrelated fields.
- `extractTournaments` / `scoreTable` score every `<table>` on the page and
  pick the highest-scoring one. The scoring weights (rows count, presence of
  year/date patterns, Hebrew headers like `תאריך|טורניר|תוצאה|מקום|שינוי`,
  English headers) are tuned for the current site layout — tweak with care
  and eyeball the `Debug · raw extracted data` `<details>` panel to verify.

**Hebrew → English presentation.** The site is English-facing. `LABEL_ALIASES`
canonicalizes ICF field keys to English internally, and `HEADER_TRANSLATIONS`
maps Hebrew tournament-table headers (`תאריך`, `תוצאה`, …) to English at render
time. Cell *values* (club names, tournament names) pass through untranslated
because they're free-form strings.

**Debug panel.** The combined raw payload from both sources (`{ icf, chesscom }`)
is dumped into `#raw-json` at the bottom on every load. Use it first when a
field looks wrong — for ICF that usually means the label didn't match any
alias or `scoreTable` picked the wrong table; for chess.com it usually means
the API shape changed (e.g., `puzzle_rush.best.score` moved).

## Deployment

Pushing to the configured Pages branch publishes automatically. No CI.
