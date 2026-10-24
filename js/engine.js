// Personalized ranking: hard filters → near misses with reasons → scored matches
// with "why it fits you" and "heads up" notes.

import { FARMS, ACTIVITIES } from "./data.js";

const FRUIT = ["apples", "pears", "berries", "peaches"];
const KID_EXTRAS = ["animals", "playground", "hayride", "cornMaze", "pumpkins"];
const ROAD_FACTOR = 1.25; // straight line → typical road distance around NYC
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function haversineMiles([lat1, lng1], [lat2, lng2]) {
  const R = 3958.8, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const driveMinutes = (roadMiles) => Math.round((roadMiles / 38) * 60 + 12);

export function fmtMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = Math.round((min % 60) / 5) * 5;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const mmdd = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inWindow = ([start, end], d) => {
  const k = mmdd(d);
  return start <= end ? k >= start && k <= end : k >= start || k <= end;
};
const fmtMMDD = (s) => `${MONTH[+s.slice(0, 2) - 1]} ${+s.slice(3)}`;

export function targetDates(when, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const add = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  const dow = today.getDay();
  switch (when) {
    case "today": return [today];
    case "tomorrow": return [add(1)];
    case "saturday": return [add((6 - dow + 7) % 7)];
    case "sunday": return [add((7 - dow) % 7)];
    case "any": return [...Array(14)].map((_, i) => add(i));
    case "weekend":
    default:
      if (dow === 6) return [today, add(1)];
      if (dow === 0) return [today];
      return [add(6 - dow), add(7 - dow)];
  }
}

export function describeDates(dates) {
  if (dates.length > 3) return "the next two weeks";
  return dates.map((d) => `${DAY[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()}`).join(" & ");
}

function availability(farm, dates) {
  const openDates = dates.filter((d) => farm.openDays.includes(d.getDay()) && inWindow(farm.season, d));
  const acts = {};
  for (const act of farm.activities) {
    const days = openDates.filter((d) => inWindow([act.start, act.end], d));
    if (days.length) acts[act.type] = { ...act, days };
  }
  return { openDates, acts };
}

const satisfies = (want, acts) => (want === "fruit" ? FRUIT.some((f) => acts[f]) : !!acts[want]);
const wantLabel = (w) => (w === "fruit" ? "fruit picking" : ACTIVITIES[w].label.toLowerCase());

/**
 * profile = {
 *   origin: [lat, lng], maxMiles, when,
 *   wants: [...]        must-haves (activity keys or "fruit")
 *   nice:  [...]        nice-to-haves
 *   party: { kids, toddler, dog, accessible }
 *   prefs: { quiet, budget, transit }
 * }
 */
export function rank(profile, now = new Date()) {
  const dates = targetDates(profile.when, now);
  const lastDate = dates[dates.length - 1];
  const matches = [], misses = [];

  for (const farm of FARMS) {
    const straight = haversineMiles(profile.origin, [farm.lat, farm.lng]);
    const miles = Math.round(straight * ROAD_FACTOR);
    const minutes = driveMinutes(miles);
    const { openDates, acts } = availability(farm, dates);

    // ---- hard filters, collected so we can explain near misses
    const blockers = [];
    if (miles > profile.maxMiles) blockers.push({ kind: "distance", text: `~${miles} mi — ${miles - profile.maxMiles} mi past your limit`, cost: (miles - profile.maxMiles) / profile.maxMiles });
    if (!openDates.length) blockers.push({ kind: "closed", text: `Closed ${describeDates(dates)}`, cost: 1 });
    else for (const w of profile.wants) if (!satisfies(w, acts)) blockers.push({ kind: "activity", text: `No ${wantLabel(w)} ${describeDates(dates)}`, cost: 0.6 });
    if (profile.party.dog && !farm.amenities.dogs) blockers.push({ kind: "dog", text: "Dogs not allowed", cost: 0.5 });
    if (profile.party.accessible && !farm.amenities.accessible) blockers.push({ kind: "access", text: "Limited wheelchair access", cost: 0.5 });

    const base = { farm, miles, minutes, openDates, acts };
    if (blockers.length) {
      misses.push({ ...base, blockers, cost: blockers.reduce((s, b) => s + b.cost, 0) });
      continue;
    }

    // ---- scoring
    let score = 55;
    const why = [], heads = [];

    // Distance: closer is better, relative to the user's own limit
    const closeness = 1 - miles / profile.maxMiles;
    score += 18 * closeness;
    why.push(`${fmtMinutes(minutes)} drive (~${miles} mi)${closeness > 0.5 ? " — one of the easier trips" : ""}`);

    // Must-haves
    for (const w of profile.wants) {
      const keys = w === "fruit" ? FRUIT.filter((f) => acts[f]) : [w];
      for (const k of keys) {
        const act = acts[k];
        why.push(`${ACTIVITIES[k].emoji} ${ACTIVITIES[k].label} in season (through ~${fmtMMDD(act.end)})`);
        const daysLeft = daysUntil(act.end, lastDate);
        if (daysLeft <= 8) heads.push(`${ACTIVITIES[k].label} usually wraps up around ${fmtMMDD(act.end)} — pickings can be thin; call ahead`);
      }
    }

    // Nice-to-haves
    for (const n of profile.nice || []) {
      if (profile.wants.includes(n)) continue;
      if (satisfies(n, acts)) { score += 5; }
      else score -= 2;
    }
    const niceHit = (profile.nice || []).filter((n) => !profile.wants.includes(n) && satisfies(n, acts));
    if (niceHit.length) why.push(`Also has ${niceHit.map(wantLabel).join(", ")}`);

    // Family fit
    if (profile.party.kids) {
      const extras = KID_EXTRAS.filter((k) => acts[k] && !profile.wants.includes(k));
      score += Math.min(12, extras.length * 4);
      if (extras.length >= 2) why.push(`Kid-friendly extras: ${extras.map((k) => ACTIVITIES[k].label.toLowerCase()).join(", ")}`);
      if (farm.amenities.restrooms && farm.amenities.food) score += 3;
      if (!farm.amenities.food) heads.push("No food on site — pack snacks");
    }
    if (profile.party.toddler) {
      if (farm.amenities.stroller) { score += 6; why.push("Stroller-friendly paths"); }
      else { score -= 6; heads.push("Hilly / not stroller-friendly — bring a carrier"); }
    }
    if (profile.party.dog) why.push("Dogs welcome");

    // Personal preferences
    if (profile.prefs.quiet) {
      if (farm.crowd === 1) { score += 10; why.push("Usually uncrowded"); }
      if (farm.crowd === 3) { score -= 10; }
    }
    if (profile.prefs.budget) {
      if (farm.price === 1) { score += 8; why.push("Easy on the wallet — pay for what you pick"); }
      if (farm.price === 3) score -= 8;
    }
    if (profile.prefs.transit) {
      if (farm.transit) { score += 12; why.push(`Reachable without a car: ${farm.transit}`); }
      else score -= 4;
    }

    // Practical heads-up notes
    const weekend = dates.some((d) => d.getDay() === 0 || d.getDay() === 6);
    if (/timed|reservation|online|wristband/i.test(farm.tickets)) heads.unshift(`${farm.tickets}`);
    else if (weekend && /admission|parking fee/i.test(farm.tickets)) heads.push(farm.tickets);
    if (weekend && farm.crowd === 3 && !profile.prefs.quiet) heads.push("Very busy on fall weekends — arrive at opening");
    if (weekend && farm.crowd === 3 && profile.prefs.quiet) heads.push("Popular spot — go right at opening to dodge crowds");
    if (openDates.length < dates.length && dates.length <= 2) heads.push(`Open only ${describeDates(openDates)}`);

    matches.push({ ...base, score: Math.max(1, Math.min(99, Math.round(score))), why, heads });
  }

  matches.sort((a, b) => b.score - a.score || a.miles - b.miles);
  misses.sort((a, b) => a.cost - b.cost);
  return { dates, matches, misses: misses.filter((m) => m.cost < 0.7).slice(0, 5) };
}

/**
 * Rank farms found through Google Places. Google gives ratings and opening
 * hours (so we can check your dates), but not seasons or activities — those
 * are "likely", inferred from the name, type and which search found them.
 */
export function rankPlaces(profile, places, curatedMatches = [], now = new Date()) {
  const curated = curatedMatches.map((m) => m.farm);
  const dates = targetDates(profile.when, now);
  const out = [];
  for (const f of places) {
    const miles = Math.round(haversineMiles(profile.origin, [f.lat, f.lng]) * ROAD_FACTOR);
    if (miles > profile.maxMiles) continue;
    if (curated.some((c) => haversineMiles([c.lat, c.lng], [f.lat, f.lng]) < 0.6 || sameName(c.name, f.name))) continue;

    const why = [], heads = [];
    // Opening hours: skip places Google lists as closed on every one of your dates
    if (f.openDays) {
      const openOn = dates.filter((d) => f.openDays.includes(d.getDay()));
      if (!openOn.length) continue;
      why.push(`Open ${describeDates(openOn)} per Google`);
    } else {
      heads.push("No hours on Google — call before you go");
    }
    if (f.status === "CLOSED_TEMPORARILY") heads.unshift("Google lists it as temporarily closed");

    const hints = new Set(f.hints);
    const fruitHint = FRUIT.some((x) => hints.has(x)) || hints.has("pyo");
    let score = 40 + 16 * (1 - miles / profile.maxMiles);
    for (const w of profile.wants) {
      const hit = w === "fruit" ? fruitHint : hints.has(w);
      if (hit) { score += 12; why.push(`Likely ${wantLabel(w)}`); }
      else { score -= 10; heads.push(`Can't confirm ${wantLabel(w)} — check first`); }
    }
    if (f.rating) {
      if (f.ratingCount >= 20) score += (f.rating - 4) * 12; // 4.8★ → +10, 3.5★ → -6
      why.push(`★ ${f.rating.toFixed(1)} from ${f.ratingCount.toLocaleString()} Google reviews`);
    }
    if (hints.has("pyo")) score += 4;

    out.push({ farm: f, miles, minutes: driveMinutes(miles), score: Math.max(1, Math.min(92, Math.round(score))), why, heads, hints: [...hints] });
  }
  return out.sort((a, b) => b.score - a.score || a.miles - b.miles).slice(0, 20);
}

const sameName = (a, b) => {
  const n = (s) => s.toLowerCase().replace(/\b(farms?|orchards?|the|&|and|family|country)\b/g, "").replace(/[^a-z]/g, "");
  return n(a) && n(a) === n(b);
};

function daysUntil(endMMDD, from) {
  const end = new Date(from.getFullYear(), +endMMDD.slice(0, 2) - 1, +endMMDD.slice(3));
  return Math.round((end - from) / 86400000);
}
