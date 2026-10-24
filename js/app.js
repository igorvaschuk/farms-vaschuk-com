import { ACTIVITIES, PLACES, FARMS } from "./data.js";
import { parseQuery } from "./parser.js";
import { rank, rankPlaces, describeDates, fmtMinutes } from "./engine.js";
import { importLibrary, geocodePlace, searchFarms, MAP_ID } from "./google.js";

const $ = (s) => document.querySelector(s);
const STORE = "farmday.profile.v1";

const EXAMPLES = [
  "Brooklyn family, fruit picking, less than 60 miles, open this weekend",
  "Apple picking with a toddler from Astoria, under an hour",
  "Quiet pumpkin patch from Hoboken, dog-friendly",
  "No car — farm reachable by train from Manhattan with animals",
  "Cider donuts and a winery from Park Slope, 90 miles",
];

const CHOICES = ["fruit", "apples", "pumpkins", "cornMaze", "hayride", "animals", "playground", "berries", "pears", "donuts", "drinks", "flowers"];
const PARTY = [
  ["kids", "🧒 Kids"], ["toddler", "👶 Toddler / stroller"], ["dog", "🐕 Dog"], ["accessible", "♿ Wheelchair"],
];
const PREFS = [["quiet", "🤫 Fewer crowds"], ["budget", "💵 Budget-friendly"], ["transit", "🚆 Reachable by transit"]];

const DEFAULT = {
  q: "", originName: "Brooklyn", origin: PLACES.brooklyn, maxMiles: 60, when: "weekend",
  wants: ["fruit"], nice: [], party: { kids: true }, prefs: {},
};

let pendingPlace = null;
let state = load();
let map, markers = {}, overlays = [], infoWindow, gm; // gm = loaded Google Maps classes
let osmTimer, osmToken = 0, lastOsm = [];
const OSM_THRESHOLD = 6; // search Google for more farms when curated results are thinner than this

/* ---------------- state ---------------- */
function load() {
  const fromUrl = readUrl();
  if (fromUrl) return fromUrl;
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && s.origin) return { ...structuredClone(DEFAULT), ...s }; } catch {}
  return structuredClone(DEFAULT);
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
  const p = new URLSearchParams();
  p.set("from", state.originName); p.set("ll", state.origin.map((n) => n.toFixed(4)).join(","));
  p.set("mi", state.maxMiles); p.set("when", state.when);
  if (state.wants.length) p.set("must", state.wants.join(","));
  if (state.nice.length) p.set("nice", state.nice.join(","));
  const party = Object.keys(state.party).filter((k) => state.party[k]);
  const prefs = Object.keys(state.prefs).filter((k) => state.prefs[k]);
  if (party.length) p.set("who", party.join(","));
  if (prefs.length) p.set("pref", prefs.join(","));
  history.replaceState(null, "", `?${p}`);
}
function readUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has("q")) {
    const s = structuredClone(DEFAULT); s.wants = []; s.party = {};
    const unknownPlace = applyParsed(s, parseQuery(p.get("q"))); s.q = p.get("q");
    if (unknownPlace) pendingPlace = unknownPlace; // geocoded at boot
    return s;
  }
  if (!p.has("ll")) return null;
  const list = (k) => (p.get(k) || "").split(",").filter(Boolean);
  const flags = (k) => Object.fromEntries(list(k).map((x) => [x, true]));
  return {
    q: "", originName: p.get("from") || "your spot", origin: p.get("ll").split(",").map(Number),
    maxMiles: +p.get("mi") || 60, when: p.get("when") || "weekend",
    wants: list("must"), nice: list("nice"), party: flags("who"), prefs: flags("pref"),
  };
}

/* ---------------- parsing free text into state ---------------- */
function applyParsed(s, parsed) {
  if (parsed.origin) { s.originName = title(parsed.origin); s.origin = PLACES[parsed.origin]; }
  if (parsed.maxMiles) s.maxMiles = Math.min(150, Math.max(10, parsed.maxMiles));
  if (parsed.when) s.when = parsed.when;
  if (parsed.wants.length) { s.wants = parsed.wants; s.nice = s.nice.filter((n) => !parsed.wants.includes(n)); }
  s.party = { ...s.party, ...parsed.party };
  s.prefs = { ...s.prefs, ...parsed.prefs };
  return parsed.originText;
}

async function onAsk(text) {
  state.q = text;
  const parsed = parseQuery(text);
  // A fresh question resets activities & companions to what was said
  state.wants = []; state.nice = []; state.party = {}; state.prefs = {};
  const unknownPlace = applyParsed(state, parsed);
  if (unknownPlace) await geocode(unknownPlace);
  syncControls(); update();
  document.querySelector(".intent").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

async function geocode(text) {
  const status = $("#fromStatus");
  const key = text.toLowerCase().trim();
  if (PLACES[key]) { state.originName = title(key); state.origin = PLACES[key]; status.textContent = ""; status.className = "status"; return true; }
  status.textContent = "Looking up…"; status.className = "status";
  try {
    const hit = await geocodePlace(text);
    if (!hit) throw new Error("not found");
    state.origin = [hit.lat, hit.lng];
    state.originName = text.replace(/\b\w/g, (c) => c.toUpperCase());
    status.textContent = hit.label;
    return true;
  } catch {
    status.textContent = `Couldn't find "${text}" — try a neighborhood or ZIP.`; status.className = "status err";
    return false;
  }
}

/* ---------------- controls ---------------- */
function buildControls() {
  $("#examples").append(...EXAMPLES.map((t) => {
    const b = el("button", { type: "button" }, t);
    b.onclick = () => { $("#q").value = t; onAsk(t); };
    return b;
  }));
  $("#placelist").append(...Object.keys(PLACES).map((k) => el("option", { value: title(k) })));

  $("#activityChips").append(...CHOICES.map((key) => {
    const meta = key === "fruit" ? { emoji: "🧺", label: "Any fruit picking" } : ACTIVITIES[key];
    const c = el("button", { type: "button", class: "chip", "data-key": key },
      el("span", { class: "mark" }), `${meta.emoji} ${meta.label}`);
    c.onclick = () => {
      const st = stateOf(key);
      state.wants = state.wants.filter((w) => w !== key);
      state.nice = state.nice.filter((w) => w !== key);
      if (st === "off") state.wants.push(key); else if (st === "must") state.nice.push(key);
      syncControls(); update();
    };
    return c;
  }));
  const toggles = (list, bucket, host) => host.append(...list.map(([key, label]) => {
    const c = el("button", { type: "button", class: "chip", "data-key": key, "aria-pressed": "false" }, label);
    c.onclick = () => {
      state[bucket][key] = !state[bucket][key];
      if (bucket === "party" && key === "toddler" && state.party.toddler) state.party.kids = true;
      syncControls(); update();
    };
    return c;
  }));
  toggles(PARTY, "party", $("#partyChips"));
  toggles(PREFS, "prefs", $("#prefChips"));

  $("#miles").oninput = (e) => { state.maxMiles = +e.target.value; syncControls(); update(); };
  $("#when").onchange = (e) => { state.when = e.target.value; update(); };
  $("#from").onchange = async (e) => { if (await geocode(e.target.value)) { syncControls(); update(); } };
  $("#locate").onclick = () => {
    const status = $("#fromStatus");
    if (!navigator.geolocation) { status.textContent = "Location isn't available in this browser."; return; }
    status.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      (pos) => { state.origin = [pos.coords.latitude, pos.coords.longitude]; state.originName = "My location"; status.textContent = ""; syncControls(); update(); },
      () => { status.textContent = "Couldn't get your location."; status.className = "status err"; },
      { timeout: 8000 },
    );
  };
  $("#ask").onsubmit = (e) => { e.preventDefault(); const t = $("#q").value.trim(); if (t) onAsk(t); };
  $("#q").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask").requestSubmit(); } };
  document.querySelectorAll(".view-toggle button").forEach((b) => b.onclick = () => {
    document.querySelectorAll(".view-toggle button").forEach((x) => x.setAttribute("aria-selected", x === b));
    $("#split").dataset.view = b.dataset.view;
    if (b.dataset.view === "map" && map) setTimeout(fitMap, 50);
  });
}

const stateOf = (key) => (state.wants.includes(key) ? "must" : state.nice.includes(key) ? "nice" : "off");

function syncControls() {
  $("#q").value = state.q || "";
  $("#from").value = state.originName;
  $("#miles").value = state.maxMiles;
  $("#milesOut").textContent = `${state.maxMiles} mi · ~${fmtMinutes(Math.round(state.maxMiles / 38 * 60 + 12))}`;
  $("#when").value = state.when;
  document.querySelectorAll("#activityChips .chip").forEach((c) => {
    const st = stateOf(c.dataset.key);
    c.dataset.state = st;
    c.querySelector(".mark").textContent = st === "must" ? "✓" : st === "nice" ? "♡" : "";
    c.setAttribute("aria-label", `${c.textContent.trim()} — ${st === "off" ? "not needed" : st === "must" ? "must-have" : "nice-to-have"}`);
  });
  document.querySelectorAll("#partyChips .chip").forEach((c) => c.setAttribute("aria-pressed", !!state.party[c.dataset.key]));
  document.querySelectorAll("#prefChips .chip").forEach((c) => c.setAttribute("aria-pressed", !!state.prefs[c.dataset.key]));
}

/* ---------------- results ---------------- */
function update() {
  save();
  const { dates, matches, misses } = rank(state);
  lastOsm = [];
  const wantOsm = matches.length < OSM_THRESHOLD;
  renderSummary(dates, matches, 0);
  renderList(matches, dates, wantOsm);
  renderMisses(misses);
  renderMap(matches);
  if (wantOsm) loadOsm(dates, matches); else { osmToken++; $("#osm").hidden = true; }
}

// More farms from Google Places, debounced so slider drags don't spam the API
function loadOsm(dates, matches) {
  const token = ++osmToken;
  const sec = $("#osm");
  sec.hidden = false;
  sec.replaceChildren(el("div", { class: "loading" }, `Looking up more farms near ${state.originName}…`));
  clearTimeout(osmTimer);
  osmTimer = setTimeout(async () => {
    let found;
    try { found = await searchFarms(state.origin, state.maxMiles / 1.25, state.wants); }
    catch {
      if (token !== osmToken) return;
      sec.replaceChildren(el("p", { class: "loading-err" }, "Couldn't load more farms right now. Try again in a minute."));
      return;
    }
    if (token !== osmToken) return; // a newer search started meanwhile
    const ranked = rankPlaces(state, found, matches);
    lastOsm = ranked;
    renderSummary(dates, matches, ranked.length);
    if (!matches.length) $("#results").replaceChildren();
    renderOsm(ranked, matches.length);
    renderMap(matches);
  }, 700);
}

function renderOsm(list, offset) {
  const sec = $("#osm");
  if (!list.length) {
    sec.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, `No farms found within ${state.maxMiles} mi of ${state.originName}`),
      el("p", {}, "Try a longer drive or a nearby town.")));
    return;
  }
  sec.replaceChildren(
    el("div", { class: "osm-head" },
      el("h3", {}, offset ? `More farms near ${state.originName}` : `Farms near ${state.originName}`),
      el("p", {}, "Found on Google Maps. Hours and ratings come from Google; we can't confirm seasons or activities yet, so check with the farm before you go.")),
    el("ol", { class: "osm-list" }, ...list.map((m, i) => osmCard(m, offset + i + 1))));
}

function osmCard(m, n) {
  const f = m.farm;
  const where = [f.town, f.state].filter(Boolean).join(", ");
  const gq = encodeURIComponent(`${f.name} ${where}`);
  const li = el("li", { class: "osm-card", id: `farm-${f.id}` },
    el("div", { class: "card-head" },
      el("div", { class: "rank" }, String(n)),
      el("div", {},
        el("h3", {}, f.name),
        el("div", { class: "where" }, `${f.kind}${where ? ` · ${where}` : ""} · ${fmtMinutes(m.minutes)} · ~${m.miles} mi`),
        f.rating ? el("div", { class: "rating", title: `${f.ratingCount} Google reviews` }, `★ ${f.rating.toFixed(1)}`, el("span", {}, ` (${f.ratingCount.toLocaleString()})`)) : null),
      el("div", { class: "score" }, el("b", {}, `${m.score}%`), el("span", {}, "match"))),
    el("div", { class: "notes" },
      m.why.length ? el("div", {}, el("h4", {}, "Why it might fit"), el("ul", { class: "why" }, ...m.why.map((t) => el("li", {}, t)))) : el("div"),
      el("div", {}, el("h4", {}, "Heads up"), el("ul", { class: "heads" }, ...m.heads.map((t) => el("li", {}, t))))),
    el("div", { class: "card-foot" },
      f.hoursText ? el("details", { class: "hours" }, el("summary", {}, "Hours"), el("ul", {}, ...f.hoursText.map((t) => el("li", {}, t)))) : el("span", { class: "hours" }),
      f.website ? el("a", { href: f.website, target: "_blank", rel: "noopener nofollow" }, "Website") : null,
      el("a", { href: `https://www.google.com/maps/dir/?api=1&origin=${state.origin.join(",")}&destination=${encodeURIComponent(f.name)}&destination_place_id=${f.id.slice(2)}`, target: "_blank", rel: "noopener" }, "Directions"),
      f.mapsUrl ? el("a", { href: f.mapsUrl, target: "_blank", rel: "noopener" }, "Google Maps") : el("a", { href: `https://www.google.com/search?q=${gq}+hours`, target: "_blank", rel: "noopener" }, "Check hours"),
      Object.assign(el("button", { type: "button" }, "On map"), { onclick: () => focus(f.id, true) })));
  li.addEventListener("mouseenter", () => highlight(f.id));
  return li;
}

function renderSummary(dates, matches, osmCount = 0) {
  const who = [state.party.toddler ? "a toddler" : state.party.kids ? "kids" : null, state.party.dog ? "a dog" : null].filter(Boolean);
  const wants = state.wants.map((w) => (w === "fruit" ? "fruit picking" : ACTIVITIES[w].label.toLowerCase()));
  $("#summary").replaceChildren(
    el("h2", {}, matches.length
      ? `${matches.length} farm${matches.length === 1 ? "" : "s"} fit your day${osmCount ? ` + ${osmCount} more nearby` : ""}`
      : osmCount ? `${osmCount} farm${osmCount === 1 ? "" : "s"} near ${state.originName}` : "Searching nearby farms"),
    el("p", {}, [
      `Open ${describeDates(dates)}`,
      `within ~${state.maxMiles} mi of ${state.originName}`,
      wants.length ? `with ${wants.join(" + ")}` : null,
      who.length ? `good for ${who.join(" & ")}` : null,
    ].filter(Boolean).join(" · ")),
  );
}

function renderList(matches, dates, osmComing = false) {
  const ol = $("#results");
  if (!matches.length && osmComing) { ol.replaceChildren(); return; }
  if (!matches.length) {
    ol.replaceChildren(el("li", { class: "empty" },
      el("h3", {}, "No farm checks every box"),
      el("p", {}, "Try a longer drive, a different day, or turn a must-have into a nice-to-have. The closest calls are listed below with what ruled them out.")));
    return;
  }
  ol.replaceChildren(...matches.map((m, i) => card(m, i + 1)));
}

function card(m, n) {
  const f = m.farm;
  const wanted = new Set(state.wants.flatMap((w) => (w === "fruit" ? ["apples", "pears", "berries", "peaches"] : [w])));
  const acts = f.activities.map((a) => {
    const on = !!m.acts[a.type];
    return el("span", { class: `act ${on ? "on" : "off"} ${on && wanted.has(a.type) ? "want" : ""}`, title: on ? "Available on your dates" : "Out of season on your dates" },
      `${ACTIVITIES[a.type].emoji} ${ACTIVITIES[a.type].label}`);
  });
  const gq = encodeURIComponent(`${f.name} ${f.town} ${f.state}`);
  const li = el("li", { class: "card", id: `farm-${f.id}` },
    el("div", { class: "card-head" },
      el("div", { class: "rank" }, String(n)),
      el("div", {},
        el("h3", {}, f.name, f.verified ? null : el("span", { class: "unverified", title: "Hours and seasons not yet confirmed with the farm" }, "unverified")),
        el("div", { class: "where" }, `${f.town}, ${f.state} · ${fmtMinutes(m.minutes)} · ~${m.miles} mi`)),
      el("div", { class: "score" }, el("b", {}, `${m.score}%`), el("span", {}, "match"))),
    el("p", { class: "blurb" }, f.blurb),
    el("div", { class: "acts" }, ...acts),
    el("div", { class: "notes" },
      el("div", {}, el("h4", {}, "Why it fits you"), el("ul", { class: "why" }, ...m.why.map((t) => el("li", {}, t)))),
      m.heads.length ? el("div", {}, el("h4", {}, "Heads up"), el("ul", { class: "heads" }, ...m.heads.map((t) => el("li", {}, t)))) : el("div")),
    el("div", { class: "card-foot" },
      el("span", { class: "hours" }, `Typical hours: ${f.hours}`),
      el("a", { href: `https://www.google.com/maps/dir/?api=1&origin=${state.origin.join(",")}&destination=${f.lat},${f.lng}`, target: "_blank", rel: "noopener" }, "Directions"),
      el("a", { href: `https://www.google.com/search?q=${gq}+hours+picking+report`, target: "_blank", rel: "noopener" }, "Check today's hours"),
      Object.assign(el("button", { type: "button", class: "show-map" }, "On map"), { onclick: () => focus(f.id, true) })),
  );
  li.addEventListener("mouseenter", () => highlight(f.id));
  return li;
}

function renderMisses(misses) {
  const sec = $("#misses");
  if (!misses.length) { sec.hidden = true; return; }
  sec.hidden = false;
  sec.replaceChildren(
    el("h3", {}, "Almost made it"),
    el("p", {}, "These miss one of your requirements — sometimes worth it anyway."),
    el("ul", { class: "miss-list" }, ...misses.map((m) => {
      const fix = m.blockers.length === 1 && m.blockers[0].kind === "distance"
        ? Object.assign(el("button", { type: "button" }, `Extend to ${Math.ceil(m.miles / 5) * 5} mi →`), {
            onclick: () => { state.maxMiles = Math.min(150, Math.ceil(m.miles / 5) * 5); syncControls(); update(); },
          })
        : null;
      return el("li", { class: "miss" },
        el("b", {}, m.farm.name),
        `${m.farm.town}, ${m.farm.state} · ${fmtMinutes(m.minutes)}`,
        el("div", { class: "why-not" }, m.blockers.map((b) => b.text).join(" · ")),
        fix);
    })));
}

/* ---------------- map ---------------- */
async function initMap() {
  try {
    const [{ Map, Circle, InfoWindow }, { AdvancedMarkerElement }, { LatLngBounds }] =
      await Promise.all([importLibrary("maps"), importLibrary("marker"), importLibrary("core")]);
    gm = { Circle, LatLngBounds, AdvancedMarkerElement };
    map = new Map($("#map"), {
      mapId: MAP_ID, center: toLL(state.origin), zoom: 9,
      gestureHandling: "cooperative", streetViewControl: false, mapTypeControl: false, fullscreenControl: true,
      clickableIcons: false,
    });
    infoWindow = new InfoWindow();
  } catch (e) {
    console.error(e);
    $("#map").replaceChildren(el("p", { style: "padding:20px" }, "The map couldn't load — results still work."));
    return;
  }
  renderMap(lastMatches); // draw whatever results arrived while the API loaded
}

const toLL = ([lat, lng]) => ({ lat, lng });
function pinEl(cls, id, label) {
  const d = el("div", { class: cls, "data-id": id }, el("span", {}, String(label)));
  return d;
}

let lastMatches = [];
function renderMap(matches) {
  lastMatches = matches;
  if (!map) return;
  try { drawMap(matches); } catch (e) { console.error("Map drawing failed:", e); }
}
function drawMap(matches) {
  overlays.forEach((o) => (o.setMap ? o.setMap(null) : (o.map = null)));
  overlays = []; markers = {};
  const leaf = getComputedStyle(document.documentElement).getPropertyValue("--leaf").trim() || "#2f6b3c";
  overlays.push(new gm.Circle({
    map, center: toLL(state.origin), radius: (state.maxMiles / 1.25) * 1609.34,
    strokeColor: leaf, strokeOpacity: 0.8, strokeWeight: 1.5, fillColor: leaf, fillOpacity: 0.05, clickable: false,
  }));
  overlays.push(new gm.AdvancedMarkerElement({
    map, position: toLL(state.origin), title: state.originName, content: el("div", { class: "home-pin" }), zIndex: 1,
  }));
  const add = (m, n, cls, html) => {
    const f = m.farm;
    const mk = new gm.AdvancedMarkerElement({
      map, position: { lat: f.lat, lng: f.lng }, title: `${n}. ${f.name}`, content: pinEl(cls, f.id, n), gmpClickable: true, zIndex: 100 - n,
    });
    mk.addListener("gmp-click", () => { openInfo(mk, html); focus(f.id, false); });
    mk._html = html;
    overlays.push(mk); markers[f.id] = mk;
  };
  matches.forEach((m, i) => add(m, i + 1, "pin",
    `<b>${i + 1}. ${escapeHtml(m.farm.name)}</b><br>${escapeHtml(m.farm.town)}, ${escapeHtml(m.farm.state)} · ${fmtMinutes(m.minutes)}<br>${m.score}% match`));
  lastOsm.forEach((m, i) => {
    const f = m.farm, n = matches.length + i + 1;
    const where = [f.town, f.state].filter(Boolean).join(", ");
    add(m, n, "pin osm",
      `<b>${n}. ${escapeHtml(f.name)}</b><br>${escapeHtml(f.kind)}${where ? ` · ${escapeHtml(where)}` : ""} · ${fmtMinutes(m.minutes)}${f.rating ? `<br>★ ${f.rating.toFixed(1)} (${f.ratingCount})` : ""}`);
  });
  fitMap();
}
function openInfo(mk, html) {
  const box = document.createElement("div");
  box.className = "info";
  box.innerHTML = html; // built only from escaped values above
  infoWindow.setContent(box);
  infoWindow.open({ map, anchor: mk });
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function fitMap() {
  if (!map) return;
  const pts = [state.origin, ...lastMatches.map((m) => [m.farm.lat, m.farm.lng]), ...lastOsm.map((m) => [m.farm.lat, m.farm.lng])];
  if (pts.length < 2) { map.setCenter(toLL(state.origin)); map.setZoom(9); return; }
  const b = new gm.LatLngBounds();
  pts.forEach((p) => b.extend(toLL(p)));
  map.fitBounds(b, 40);
  google.maps.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > 11) map.setZoom(11); });
}
function highlight(id) {
  document.querySelectorAll(".pin").forEach((p) => p.classList.toggle("active", p.dataset.id === id));
  document.querySelectorAll(".card, .osm-card").forEach((c) => c.classList.toggle("active", c.id === `farm-${id}`));
}
function focus(id, fromCard) {
  highlight(id);
  const mk = markers[id];
  if (fromCard) {
    if (getComputedStyle(document.querySelector(".view-toggle")).display !== "none") document.querySelector('.view-toggle [data-view="map"]').click();
    if (mk && map) { map.panTo(mk.position); if (map.getZoom() < 11) map.setZoom(11); openInfo(mk, mk._html); }
  } else {
    document.getElementById(`farm-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/* ---------------- helpers ---------------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
}
function title(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bNyc\b/, "NYC"); }

/* ---------------- boot ---------------- */
buildControls();
initMap();
syncControls();
if (pendingPlace) {
  geocode(pendingPlace).then(() => { pendingPlace = null; syncControls(); update(); });
} else {
  update();
}
console.info(`Farm Day: ${FARMS.length} farms loaded`);
