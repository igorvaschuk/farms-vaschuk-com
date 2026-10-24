// Farms from OpenStreetMap, served as static 1°x1° tiles from this site
// (data/osm/, rebuilt monthly by .github/workflows/refresh-farm-data.yml).
// OSM knows names, locations and sometimes websites/hours, but not seasons
// or activities, so results are labeled as less certain in the UI.

const BASE = new URL("../data/osm/", import.meta.url);
const tileCache = new Map();
let indexPromise;

function loadIndex() {
  indexPromise ??= fetchJson(new URL("index.json", BASE))
    .then((j) => new Set(j?.tiles || []))
    .catch(() => new Set());
  return indexPromise;
}

async function fetchJson(url, ms = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function loadTile(key) {
  if (!tileCache.has(key)) {
    tileCache.set(key, fetchJson(new URL(`${key}.json`, BASE)).catch((e) => {
      tileCache.delete(key); // allow a retry later
      throw e;
    }));
  }
  return tileCache.get(key);
}

/** Farms within `radiusMiles` (straight line) of [lat, lng]. */
export async function fetchOsmFarms([lat, lng], radiusMiles) {
  const index = await loadIndex();
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const keys = [];
  for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) {
    for (let lo = Math.floor(lng - dLng); lo <= Math.floor(lng + dLng); lo++) {
      if (index.has(`${la}_${lo}`)) keys.push(`${la}_${lo}`);
    }
  }
  const tiles = await Promise.all(keys.map(loadTile));
  const out = [];
  tiles.flat().forEach(([name, flat, flng, kind, town, state, website, hours, hints], i) => {
    out.push({
      id: `osm-${flat}-${flng}-${i}`.replace(/\./g, "_"),
      source: "osm",
      name, lat: flat, lng: flng, kind, town, state,
      website: safeUrl(website), hours, hints: hints || [],
    });
  });
  return out;
}

// Defense in depth: the build already filters links, but OSM data is user-contributed
function safeUrl(u) {
  if (!u) return null;
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
