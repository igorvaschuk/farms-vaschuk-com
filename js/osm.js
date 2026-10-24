// Live farm lookup from OpenStreetMap (Overpass API), so searches work
// anywhere — not just where we have curated records.
// OSM knows names, locations and sometimes websites/hours, but not seasons
// or activities, so results are labeled as less certain in the UI.

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const cache = new Map();

// Words in a farm's name or tags that hint at what you can do there
const HINTS = [
  [/orchard|apple|cider/i, "apples"],
  [/pumpkin/i, "pumpkins"],
  [/berr(y|ies)|strawberr|blueberr|raspberr/i, "berries"],
  [/peach/i, "peaches"],
  [/pick[- ]?your[- ]?own|u[- ]?pick|pyo/i, "pyo"],
  [/maze/i, "cornMaze"],
  [/sunflower|flower/i, "flowers"],
  [/winery|vineyard|cidery/i, "drinks"],
  [/petting|animal|zoo/i, "animals"],
];

export async function fetchOsmFarms([lat, lng], radiusMiles) {
  const radius = Math.round(Math.min(radiusMiles, 120) * 1609);
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${Math.round(radius / 5000)}`;
  if (cache.has(key)) return cache.get(key);

  const around = `(around:${radius},${lat},${lng})`;
  const query = `[out:json][timeout:25];
(
  nwr["shop"="farm"]["name"]${around};
  nwr["landuse"="orchard"]["name"]${around};
  nwr["pick_your_own"="yes"]${around};
  nwr["tourism"="attraction"]["attraction"="farm"]${around};
  nwr["place"="farm"]["name"]["tourism"]${around};
);
out center tags 400;`;

  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const farms = normalize(json.elements || []);
      cache.set(key, farms);
      return farms;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function normalize(elements) {
  const out = [];
  const seen = new Set();
  for (const e of elements) {
    const t = e.tags || {};
    const name = (t.name || "").trim();
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (!name || lat == null) continue;
    // Skip things that are clearly not visitable farms
    if (/\b(llc|inc\.?|holdings|dairy cooperative|feed (store|mill)|tree service|nursery & garden center)\b/i.test(name)) continue;
    const dedupe = name.toLowerCase().replace(/[^a-z]/g, "");
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const text = [name, t.description, t.produce, t.product, t.crop, t.trees, t.species].filter(Boolean).join(" ");
    const hints = new Set(HINTS.filter(([re]) => re.test(text)).map(([, v]) => v));
    if (t.landuse === "orchard" || /apple/i.test(t.trees || "")) hints.add("apples");
    if (t.pick_your_own === "yes") hints.add("pyo");

    out.push({
      id: `osm-${e.type}-${e.id}`,
      source: "osm",
      name, lat, lng,
      kind: t.shop === "farm" ? "Farm stand" : t.landuse === "orchard" ? "Orchard" : "Farm",
      town: t["addr:city"] || t["addr:town"] || t["addr:village"] || "",
      state: t["addr:state"] || "",
      website: safeUrl(t.website || t["contact:website"]),
      hours: t.opening_hours || null,
      hints: [...hints],
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    });
  }
  return out;
}

// OSM data is user-contributed: only allow plain http(s) links
function safeUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (/^www\./i.test(u)) u = `https://${u}`;
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
