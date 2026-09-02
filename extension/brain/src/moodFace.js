// moodFace.js — the ONE canonical mapping from an affect/chem mood to a face, shared by the puppet, the race reactor, and
// the server's VTuber drive so they never diverge. Input is the bounded readout ([[neuromodulation]] readout()):
// valence∈(-1,1), arousal∈(0,1), plus optional affection (the user-bond, puppet-only). Output is an abstract expression
// and its tsumiki emotion. The quadrant logic is identical to puppetEmbodiment's resting-face selection.

export function moodToExpression({ valence = 0, arousal = 0.2, affection = 0 } = {}) {
  if (affection > 0.6 && valence > 0.12) return "love";
  if (valence > 0.4) return "happy";
  if (valence < -0.28 && arousal >= 0.45) return "annoyed";   // hot-negative
  if (valence < -0.2 && arousal < 0.4) return "sad";          // cold-negative
  if (arousal > 0.72) return "surprised";
  return "neutral";
}

// abstract expression → tsumiki's actual expressions (Normal/Angry/Blushing/Sad/Surprised). setEmotion also fires a body
// motion via the salvaged emotion-motion map, so this drives face + gesture together.
export const TSUMIKI_OF = {
  neutral: "Normal", happy: "Blushing", love: "Blushing", giggle: "Blushing",
  surprised: "Surprised", annoyed: "Angry", sad: "Sad",
};
export function tsumikiEmotion(mood) { return TSUMIKI_OF[moodToExpression(mood)] || "Normal"; }
