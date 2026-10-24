#!/usr/bin/env python3
"""Build static farm tiles from OpenStreetMap extracts.

Input: GeoJSON-sequence files produced by `osmium export` from Geofabrik
extracts that were pre-filtered with `osmium tags-filter` (see
.github/workflows/refresh-farm-data.yml).

Output: data/osm/<lat>_<lng>.json — one file per 1°x1° cell, plus
data/osm/index.json listing the cells that exist. The site loads only the
cells around the user's starting point.

Each farm is a compact array:
  [name, lat, lng, kind, town, state, website, hours, hints]
"""
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

HINTS = [
    (re.compile(r"orchard|apple|cider", re.I), "apples"),
    (re.compile(r"pumpkin", re.I), "pumpkins"),
    (re.compile(r"berr(y|ies)|strawberr|blueberr|raspberr", re.I), "berries"),
    (re.compile(r"peach", re.I), "peaches"),
    (re.compile(r"pick[- ]?your[- ]?own|u[- ]?pick|\bpyo\b", re.I), "pyo"),
    (re.compile(r"maze", re.I), "cornMaze"),
    (re.compile(r"sunflower|flower", re.I), "flowers"),
    (re.compile(r"winery|vineyard|cidery", re.I), "drinks"),
    (re.compile(r"petting|animal|zoo", re.I), "animals"),
]
SKIP_NAME = re.compile(
    r"\b(llc|inc\.?|corp|holdings|cooperative|feed (store|mill)|tree service|"
    r"garden center|landscap|supply|equipment|tractor sales)\b", re.I)


def centroid(geom):
    """Cheap centroid: mean of the outer ring / point."""
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        return c[1], c[0]
    if t == "Polygon":
        ring = c[0]
    elif t == "MultiPolygon":
        ring = max((p[0] for p in c), key=len)
    elif t == "LineString":
        ring = c
    else:
        return None
    if not ring:
        return None
    return (sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring))


def safe_url(u):
    if not u:
        return None
    u = u.strip().split(";")[0].strip()
    if u.lower().startswith("www."):
        u = "https://" + u
    try:
        p = urlparse(u)
    except ValueError:
        return None
    return u if p.scheme in ("http", "https") and p.netloc else None


def convert(feature):
    props = feature.get("properties") or {}
    name = (props.get("name") or "").strip()
    if not name or SKIP_NAME.search(name):
        return None
    geom = feature.get("geometry")
    if not geom:
        return None
    pt = centroid(geom)
    if not pt:
        return None
    lat, lng = pt

    if props.get("shop") == "farm":
        kind = "Farm stand"
    elif props.get("landuse") == "orchard":
        kind = "Orchard"
    else:
        kind = "Farm"

    text = " ".join(str(props.get(k, "")) for k in
                    ("name", "description", "produce", "product", "crop", "trees", "species"))
    hints = {v for rx, v in HINTS if rx.search(text)}
    if props.get("landuse") == "orchard" or "apple" in str(props.get("trees", "")).lower():
        hints.add("apples")
    if props.get("pick_your_own") == "yes":
        hints.add("pyo")

    town = props.get("addr:city") or props.get("addr:town") or props.get("addr:village") or ""
    return [
        name, round(lat, 5), round(lng, 5), kind, town, props.get("addr:state", ""),
        safe_url(props.get("website") or props.get("contact:website")),
        (props.get("opening_hours") or None),
        sorted(hints),
    ]


def main(inputs, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    tiles = defaultdict(list)
    seen = set()
    total = 0
    for path in inputs:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip().lstrip("\x1e")
                if not line:
                    continue
                try:
                    farm = convert(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if not farm:
                    continue
                # Same name within ~1 km counts as a duplicate (e.g. shop node + orchard polygon)
                key = (re.sub(r"[^a-z]", "", farm[0].lower()), round(farm[1], 2), round(farm[2], 2))
                if key in seen:
                    continue
                seen.add(key)
                tiles[f"{math.floor(farm[1])}_{math.floor(farm[2])}"].append(farm)
                total += 1

    for old in out.glob("*.json"):
        old.unlink()
    for key, farms in tiles.items():
        farms.sort(key=lambda f: f[0])
        (out / f"{key}.json").write_text(json.dumps(farms, separators=(",", ":"), ensure_ascii=False))
    (out / "index.json").write_text(json.dumps(
        {"tiles": sorted(tiles), "count": total, "source": "OpenStreetMap contributors (ODbL)"},
        separators=(",", ":")))
    print(f"{total} farms in {len(tiles)} tiles")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: build_osm_tiles.py OUT_DIR INPUT.geojsonseq [...]")
    main(sys.argv[2:], sys.argv[1])
