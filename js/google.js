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

/* ---------------- geocoding & place suggestions ---------------- */
// Result types precise enough to be a starting point (not a whole country)
const PLACE_TYPES = new Set([
  "locality", "sublocality", "sublocality_level_1", "neighborhood", "postal_code", "colloquial_area",
  "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3",
  "street_address", "premise", "route", "airport", "point_of_interest", "establishment", "park",
]);

/** Free text → { lat, lng, name, label } or null. Rejects empty and country-level matches. */
export async function geocodePlace(text, { strict = false } = {}) {
  text = (text || "").trim();
  if (text.length < 2) return null;
  const { Geocoder } = await importLibrary("geocoding");
  let results;
  try {
    ({ results } = await new Geocoder().geocode({ address: text, componentRestrictions: { country: "US" } }));
  } catch { return null; } // ZERO_RESULTS rejects
  const hit = results?.find((r) => r.types.some((t) => PLACE_TYPES.has(t)));
  if (!hit) return null;
  // "strict" (guessing a place from leftover words) only accepts towns, neighborhoods, ZIPs, counties, states
  if (strict && !hit.types.some((t) => /locality|neighborhood|postal_code|administrative_area|colloquial/.test(t))) return null;
  if (hit.partial_match && strict) return null;
  const loc = hit.geometry.location;
  const comp = (type) => hit.address_components.find((c) => c.types.includes(type));
  const name = (comp("neighborhood") || comp("sublocality") || comp("locality") || comp("postal_code") || comp("administrative_area_level_2") || comp("administrative_area_level_1"))?.long_name;
  return { lat: loc.lat(), lng: loc.lng(), name: name || text, label: hit.formatted_address };
}

let sessionToken = null;
/** Google place suggestions for a partially typed starting point. */
export async function suggestPlaces(input) {
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await importLibrary("places");
  sessionToken ??= new AutocompleteSessionToken(); // groups keystrokes + final pick into one billed session
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input, sessionToken, includedRegionCodes: ["us"], includedPrimaryTypes: ["(regions)"],
  });
  return (suggestions || []).filter((s) => s.placePrediction).slice(0, 6).map((s) => ({
    main: s.placePrediction.mainText?.text || s.placePrediction.text.text,
    secondary: s.placePrediction.secondaryText?.text || "",
    prediction: s.placePrediction,
  }));
}

/** Resolve a picked suggestion to coordinates (ends the autocomplete session). */
export async function resolveSuggestion(sug) {
  const place = sug.prediction.toPlace();
  await place.fetchFields({ fields: ["location", "formattedAddress", "displayName"] });
  sessionToken = null;
  return { lat: place.location.lat(), lng: place.location.lng(), name: sug.main, label: place.formattedAddress };
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
  // "691 NY-146, Altamont, NY 12009, USA" → town "Altamont", state "NY"
  const parts = addr.split(",").map((s) => s.trim()).filter((x) => !/^(usa|united states)$/i.test(x));
  return {
    id: `g-${p.id}`,
    source: "google",
    name: p.displayName || "Unnamed farm",
    lat: p.location.lat(), lng: p.location.lng(),
    kind: p.primaryTypeDisplayName || "Farm",
    town: parts.length >= 2 ? parts[parts.length - 2] : "",
    state: (parts[parts.length - 1] || "").split(" ")[0],
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
