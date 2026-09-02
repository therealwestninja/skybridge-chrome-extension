// Aggregates the per-domain knowledge packs into one ALMANAC (the offline fact bank consumed by
// lookupFact / Reflex). Add a domain by creating data/knowledge/<name>.js and importing it here.
import { FACTS as GEO } from "./knowledge/geo.js";
import { FACTS as LORE } from "./knowledge/lore.js";
import { FACTS as SCIENCE } from "./knowledge/science.js";
import { FACTS as MATH } from "./knowledge/math.js";
import { FACTS as PROGRAMMING } from "./knowledge/programming.js";
import { FACTS as ROLEPLAY } from "./knowledge/roleplay.js";
import { FACTS as SECRETARY } from "./knowledge/secretary.js";

export const ALMANAC = [
  ...GEO, ...LORE, ...SCIENCE, ...MATH, ...PROGRAMMING, ...ROLEPLAY, ...SECRETARY,
];
