// Ring buffer of pending synaptic deliveries, indexed by arrival tick offset.
// maxDelay sets the ring size; delays are clamped to [1, maxDelay].
export function makeDelayQueue(maxDelay = 20) {
  const size = maxDelay + 1;
  const slots = Array.from({ length: size }, () => []);
  let head = 0; // index representing "current" tick

  return {
    schedule(target, delay, amount) {
      const d = Math.max(1, Math.min(maxDelay, delay | 0));
      const idx = (head + d) % size;
      slots[idx].push({ target, amount });
    },
    // Advance one tick: return everything due now, then clear that slot.
    popDue() {
      head = (head + 1) % size;
      const due = slots[head];
      slots[head] = [];
      return due;
    },
    // Drop all pending deliveries (used when settling activation between turns).
    clear() { for (let i = 0; i < size; i++) slots[i] = []; },
  };
}
