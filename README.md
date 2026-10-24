# Farm Day — farms.vaschuk.com

A personalized pick-your-own farm finder for the NYC area. Instead of "a map of farms", you describe your day in plain words —

> Brooklyn family, fruit picking, less than 60 miles, open this weekend

— and the site turns that into a profile (starting point, max drive, dates, must-haves, nice-to-haves, who's coming, preferences), then ranks farms with a match score, **why it fits you**, and **heads-up** notes (timed tickets, crowds, end of season, no food on site, not stroller-friendly…). Farms that just miss are shown with the reason and a one-tap fix ("Extend to 65 mi").

## How it works

Static site, no build step, deployable on GitHub Pages.

| File | Role |
| --- | --- |
| `js/parser.js` | Free text → intent (origin, distance/time, dates, activities, party, preferences) |
| `js/engine.js` | Hard filters, near-miss reasons, scoring, explanations |
| `js/data.js` | Farm records + known starting points |
| `js/app.js` | UI, map (Leaflet + CARTO tiles), URL/localStorage state |

- Unknown starting points are geocoded with OpenStreetMap Nominatim; "use my location" uses the browser.
- Distances are straight-line × 1.25 as a road estimate; drive time assumes ~38 mph + 12 min.
- State lives in the URL, so any search is shareable. `?q=...` also works.

## Data

`js/data.js` is a **seed dataset written from general knowledge**; every record is `verified: false` and shown with an "unverified" badge. Before relying on it, confirm hours, seasons, ticket rules and pet policies with each farm, then set `verified: true`.

## Deploy

1. Repo → Settings → Pages → Deploy from branch → `main` / root.
2. Add a DNS `CNAME` record: `farms` → `igorvaschuk.github.io`.
3. Once the certificate is issued, tick "Enforce HTTPS".

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
