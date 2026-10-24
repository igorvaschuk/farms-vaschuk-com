// Google Maps Platform: map libraries, place search and geocoding.
// The API key is a browser key restricted to this site's domains and to the
// Maps JavaScript, Places and Geocoding APIs (Google Cloud project vaschuk-com).

export const MAP_ID = "fa68174fab48eb7b24eec4a1";
const KEY = "AIzaSyB8Rom73R3Rd-0f2yy7I6VqNB5LydF1Aso";

// Google's official dynamic-import bootstrap loader
((g) => {
  var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window;
  b = b[c] || (b[c] = {});
  var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(),
    u = () => h || (h = new Promise(async (f, n) => {
      await (a = m.createElement("script"));
      e.set("libraries", [...r] + "");
      for (k in g) e.set(k.replace(/[A-Z]/g, (t) => "_" + t[0].toLowerCase()), g[k]);
      e.set("callback", c + ".maps." + q);
      a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
      d[q] = f;
      a.onerror = () => (h = n(Error(p + " could not load.")));
      a.nonce = m.querySelector("script[nonce]")?.nonce || "";
      m.head.append(a);
    }));
  d[l] ? console.warn(p + " only loads once. Ignoring:", g) : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)));
})({ key: KEY, v: "weekly" });

export const importLibrary = (name) => google.maps.importLibrary(name);

/* ---------------- geocoding ---------------- */
export async function geocodePlace(text) {
  const { Geocoder } = await importLibrary("geocoding");
  const { results } = await new Geocoder().geocode({ address: text, componentRestrictions: { country: "US" } });
  const hit = results?.[0];
  if (!hit) return null;
  const loc = hit.geometry.location;
  return { lat: loc.lat(), lng: loc.lng(), label: hit.formatted_address };
}

/* ---------------- place search ---------------- */
// What to ask Google for, depending on what the person wants to do
const QUERIES = {
  base: "pick your own farm",
  fruit: "fruit picking orchard",
  apples: "apple picking orchard",
  pears: "pick your own orchard",
  berries: "berry picking farm",
  peaches: "peach picking farm",
  pumpkins: "pumpkin patch",
  cornMaze: "corn maze",
  hayride: "farm hayride",
  animals: "farm petting zoo",
  playground: "family farm",
  donuts: "farm market cider donuts",
  drinks: "farm winery cidery",
  flowers: "sunflower field farm",
};

const HINTS = [
  [/orchard|apple|cider/i, "apples"],
  [/pumpkin/i, "pumpkins"],
  [/berr(y|ies)|strawberr|blueberr|raspberr/i, "berries"],
  [/peach/i, "peaches"],
  [/pick[- ]?your[- ]?own|u[- ]?pick|\bpyo\b/i, "pyo"],
  [/maze/i, "cornMaze"],
  [/sunflower|flower/i, "flowers"],
  [/winery|vineyard|cidery|brewery/i, "drinks"],
  [/petting|animal|zoo/i, "animals"],
  [/donut|doughnut|bakery/i, "donuts"],
  [/hayride|hay ride/i, "hayride"],
];

const FIELDS = [
  "id", "displayName", "location", "formattedAddress", "rating", "userRatingCount",
  "websiteURI", "regularOpeningHours", "googleMapsURI", "primaryTypeDisplayName", "businessStatus", "types",
];

const cache = new Map();

/**
 * Farms near [lat, lng] for the given wants. Runs at most 3 text searches
 * (cost control) and caches results for the session.
 */
export async function searchFarms([lat, lng], radiusMiles, wants = []) {
  const picked = [...new Set(["base", ...wants.filter((w) => QUERIES[w])])].slice(0, 3);
  const radius = Math.min(50000, Math.round(radiusMiles * 1609)); // Google's bias radius max is 50 km
  const { Place } = await importLibrary("places");

  const batches = await Promise.all(picked.map(async (want) => {
    const key = `${want}|${lat.toFixed(2)}|${lng.toFixed(2)}|${radius}`;
    if (!cache.has(key)) {
      cache.set(key, Place.searchByText({
        textQuery: QUERIES[want],
        fields: FIELDS,
        locationBias: { center: { lat, lng }, radius },
        maxResultCount: 20,
        region: "us",
      }).then(({ places }) => (places || []).map((p) => normalize(p, want)))
        .catch((e) => { cache.delete(key); throw e; }));
    }
    return cache.get(key);
  }));

  // Merge: same place found by several queries collects all their hints
  const byId = new Map();
  for (const p of batches.flat()) {
    const prev = byId.get(p.id);
    if (prev) prev.hints = [...new Set([...prev.hints, ...p.hints])];
    else byId.set(p.id, { ...p, hints: [...p.hints] });
  }
  return [...byId.values()].filter((p) => p.status !== "CLOSED_PERMANENTLY");
}

function normalize(p, foundBy) {
  const text = [p.displayName, p.primaryTypeDisplayName, ...(p.types || [])].join(" ");
  const hints = new Set(HINTS.filter(([re]) => re.test(text)).map(([, v]) => v));
  if (foundBy !== "base" && foundBy !== "playground") hints.add(foundBy === "fruit" ? "pyo" : foundBy);

  const hours = p.regularOpeningHours;
  let openDays = null;
  if (hours?.periods?.length) {
    openDays = new Set();
    for (const per of hours.periods) {
      if (per.open && !per.close) { [0, 1, 2, 3, 4, 5, 6].forEach((d) => openDays.add(d)); break; } // open 24/7
      if (per.open) openDays.add(per.open.day);
    }
  }
  const addr = p.formattedAddress || "";
  const parts = addr.split(",").map((s) => s.trim());
  return {
    id: `g-${p.id}`,
    source: "google",
    name: p.displayName || "Unnamed farm",
    lat: p.location.lat(), lng: p.location.lng(),
    kind: p.primaryTypeDisplayName || "Farm",
    town: parts.length >= 3 ? parts[parts.length - 3] : "",
    state: (parts[parts.length - 2] || "").split(" ")[0],
    address: addr,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? 0,
    website: safeUrl(p.websiteURI),
    mapsUrl: safeUrl(p.googleMapsURI),
    openDays: openDays ? [...openDays] : null,
    hoursText: hours?.weekdayDescriptions || null,
    status: p.businessStatus || null,
    hints: [...hints],
  };
}

function safeUrl(u) {
  if (!u) return null;
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
