// A 1-D corridor world for the sensorimotor bridge. The agent moves along [0, length]; a wall at
// `length` blocks passage. Deterministic. Senses are normalized so they map straight onto channels.
export function makeWorld({ length = 10, start = 0, step = 1 } = {}) {
  let pos = start, crashed = false;
  return {
    get pos() { return pos; },
    get crashed() { return crashed; },
    // clear = distance-to-wall (1 = far, 0 = at the wall); obstacle = proximity (its complement).
    sense() {
      const clear = length > 0 ? Math.max(0, Math.min(1, (length - pos) / length)) : 0; // guard: length 0 → 0/0 NaN would poison the motor sense
      return { clear, obstacle: 1 - clear };
    },
    act(name) {
      if (name === "FORWARD") {
        if (pos + step > length) { crashed = true; pos = length; } // the wall blocks
        else pos += step;
      } else if (name === "REVERSE") {
        pos = Math.max(0, pos - step);
      } // STOP / QUIET / anything else -> hold position
      return pos;
    },
  };
}
