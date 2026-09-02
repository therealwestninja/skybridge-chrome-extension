// temperament.js — a DISPOSITION as a durable bias on the 4-chem setpoints + reactivity ([[neuromodulation]]). Same self,
// same face-map ([[moodFace]]); the temperament sets WHERE her face idles (resting affect) and HOW HARD events swing her
// (reactivity). The event→burst reactor ([[raceReactions]]) supplies transients ON TOP. ONE knob makes "the same Rook" a
// different creature per body/context — a fierce racer, a tender companion, a wary sentinel — with zero new logic.
//
// The recipe (why these numbers land where they do), given VALENCE_CENTER=0.55 from the default setpoints:
//   valence_rest ≈ tanh(dopamine + serotonin − 0.5·norepinephrine − 0.55)   → raise 5HT/DA = warmer, raise NE = hotter/darker
//   arousal_rest ≈ tanh(norepinephrine + 0.5·acetylcholine)                 → raise NE = keyed-up, lower = calm
// Each temperament below is a POINT on that valence×arousal plane; `face` is the resting expression it targets (asserted
// by the test). reactivity scales how hard a burst lands — high = volatile/quick, low = steady/slow to move.

// A spanning set across the affect quadrants — every tsumiki face is some temperament's resting state.
export const TEMPERAMENTS = {
  calm:        { setpoints: {}, reactivity: {}, face: "Normal" },                                                                                          // the neutral default persona (~0 valence, low arousal)
  fierce:      { setpoints: { dopamine: 0.3,  norepinephrine: 0.7,  serotonin: 0.25, acetylcholine: 0.4 }, reactivity: { dopamine: 1.4, norepinephrine: 1.3 }, face: "Angry" },      // a racer / competitor: resting fury, volatile — strikes thrill, setbacks seethe
  tender:      { setpoints: { dopamine: 0.4,  norepinephrine: 0.15, serotonin: 0.7 },                       reactivity: { dopamine: 1.1 },                    face: "Blushing" },   // a companion: warm, calm, affectionate (the touch-puppet's soul)
  anxious:     { setpoints: { dopamine: 0.2,  norepinephrine: 0.7,  serotonin: 0.45, acetylcholine: 0.5 }, reactivity: { norepinephrine: 1.5 },               face: "Surprised" },  // a sentinel: on-edge, jumpy, quick to alarm
  melancholic: { setpoints: { dopamine: 0.1,  norepinephrine: 0.25, serotonin: 0.3 },                       reactivity: { dopamine: 0.8 },                    face: "Sad" },        // wistful, low, slow to lift — a quiet/rest mode
  serene:      { setpoints: { dopamine: 0.25, norepinephrine: 0.15, serotonin: 0.75, acetylcholine: 0.2 }, reactivity: { norepinephrine: 0.7 },               face: "Normal" },     // content, unflappable — a wellness/meditation register (calm-positive)
  playful:     { setpoints: { dopamine: 0.5,  norepinephrine: 0.3,  serotonin: 0.7,  acetylcholine: 0.4 }, reactivity: { dopamine: 1.5 },                    face: "Blushing" },   // bright, hype, quick to delight — a streamer/explorer register
};

// temperamentTrait(name) → { setpoints, reactivity } to pass straight into makeNeuromodulation(...). Unknown → calm.
export function temperamentTrait(name) {
  const t = TEMPERAMENTS[name] || TEMPERAMENTS.calm;
  return { setpoints: { ...(t.setpoints || {}) }, reactivity: { ...(t.reactivity || {}) } };
}
export function listTemperaments() { return Object.keys(TEMPERAMENTS); }
export function restingFace(name) { return (TEMPERAMENTS[name] || TEMPERAMENTS.calm).face; }
