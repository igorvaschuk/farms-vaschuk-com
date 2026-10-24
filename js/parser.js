// Turns a free-text request into structured intent.
// "Brooklyn, NY resident searches for a family-friendly farm with fruit picking,
//  less than 60 miles away, open this weekend"
//   -> { origin: "brooklyn", maxMiles: 60, when: "weekend", wants: ["fruit"], party: { kids: true } }

import { PLACES } from "./data.js";

const WANT_RULES = [
  [/\b(fruit[- ]?picking|pick(ing)? (your|our) own|pick[- ]?your[- ]?own|u[- ]?pick|pyo|orchards?|pick fruit)\b/, "fruit"],
  [/\bapples?\b/, "apples"],
  [/\bpears?\b/, "pears"],
  [/\b(berr(y|ies)|strawberr(y|ies)|raspberr(y|ies)|blueberr(y|ies))\b/, "berries"],
  [/\bpeach(es)?\b/, "peaches"],
  [/\bpumpkins?\b/, "pumpkins"],
  [/\b(sun)?flowers?\b/, "flowers"],
  [/\b(corn ?maze|maze)\b/, "cornMaze"],
  [/\b(hay ?rides?|tractor rides?|wagon rides?)\b/, "hayride"],
  [/\b(petting( zoo)?|farm animals|animals|goats|baby animals)\b/, "animals"],
  [/\b(playground|play area|slides|bounce)\b/, "playground"],
  [/\b(cider )?(donuts?|doughnuts?)\b|\bbakery\b|\bpies?\b/, "donuts"],
  [/\b(wine(ry)?|hard cider|cidery|brewery|tasting room)\b/, "drinks"],
];

const WHEN_RULES = [
  [/\b(this|the) weekend\b|\bweekend\b/, "weekend"],
  [/\btoday\b|\bright now\b/, "today"],
  [/\btomorrow\b/, "tomorrow"],
  [/\bsaturday\b|\bsat\b/, "saturday"],
  [/\bsunday\b|\bsun\b/, "sunday"],
];

const PLACE_KEYS = Object.keys(PLACES).sort((a, b) => b.length - a.length);

export function parseQuery(raw) {
  const text = ` ${raw.toLowerCase().replace(/[“”]/g, '"')} `;
  const out = { origin: null, originText: null, maxMiles: null, when: null, wants: [], party: {}, prefs: {} };

  // Distance: "less than 60 miles", "within 45 min", "an hour away", "1.5 hours"
  let m = text.match(/(\d+(?:\.\d+)?)\s*(?:mi\b|miles?)/);
  if (m) out.maxMiles = Math.round(parseFloat(m[1]));
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:min\b|mins\b|minutes?)/);
  if (m && !out.maxMiles) out.maxMiles = minutesToMiles(parseFloat(m[1]));
  m = text.match(/(\d+(?:\.\d+)?|an|one|two)\s*(?:h\b|hrs?\b|hours?)/);
  if (m && !out.maxMiles) {
    const h = m[1] === "an" || m[1] === "one" ? 1 : m[1] === "two" ? 2 : parseFloat(m[1]);
    out.maxMiles = minutesToMiles(h * 60);
  }

  // Origin: a known neighborhood anywhere in the text wins…
  for (const key of PLACE_KEYS) {
    if (new RegExp(`\\b${key.replace(/[-.]/g, "\\$&")}\\b`).test(text)) { out.origin = key; break; }
  }
  // …otherwise "from X", "in X", "near X"
  if (!out.origin) {
    m = text.match(/\b(?:from|in|near|around|live in|living in)\s+([a-z][a-z .'-]{2,40}?)(?=,|\s+(?:ny|nj|ct|resident|with|for|that|open|less|under|within|this|and)\b|\s*$)/);
    if (m && !/\b(the|a|an|my)$/.test(m[1].trim())) out.originText = m[1].trim();
  }

  for (const [re, val] of WHEN_RULES) if (re.test(text)) { out.when = val; break; }
  for (const [re, val] of WANT_RULES) if (re.test(text) && !out.wants.includes(val)) out.wants.push(val);
  // "fruit picking" + a specific fruit → keep only the specific fruit
  if (out.wants.includes("fruit") && out.wants.some((w) => ["apples", "pears", "berries", "peaches"].includes(w))) {
    out.wants = out.wants.filter((w) => w !== "fruit");
  }

  if (/\b(family|families|kids?|children|child|son|daughter)\b|family[- ]friendly/.test(text)) out.party.kids = true;
  if (/\b(toddlers?|baby|babies|stroller|little ones?|preschool)/.test(text)) { out.party.kids = true; out.party.toddler = true; }
  if (/\b(dogs?|pup(py|pies)?|pets?)\b/.test(text)) out.party.dog = true;
  if (/\b(wheelchair|accessible|accessibility|mobility)\b/.test(text)) out.party.accessible = true;

  if (/\b(quiet|uncrowded|less crowded|not crowded|low[- ]key|calm|no crowds)\b/.test(text)) out.prefs.quiet = true;
  if (/\b(cheap|budget|free|inexpensive|affordable)\b/.test(text)) out.prefs.budget = true;
  if (/\b(train|transit|no car|without a car|lirr|metro[- ]north|nj transit|bus)\b/.test(text)) out.prefs.transit = true;

  return out;
}

export function minutesToMiles(min) {
  // Inverse of the drive-time estimate used in engine.js
  return Math.max(10, Math.round(((min - 12) / 60) * 38));
}
