// shrinkGuard.js — refuse a persist that would CLOBBER good memory with a suddenly-tiny set. A load failure, a bug that
// empties `records`, or a truncated read can leave the in-memory store near-empty; without a guard the next routine
// persist overwrites the DURABLE copy with that emptiness — a silent memory-wipe with no recovery. Mined from a dashcam
// sync-guard (refuse to overwrite the archive if the new set is < half the last good). The durable copy is the recovery
// source, so protecting it means a bad truncation self-heals on the next reload instead of becoming permanent.
//
// Fail SAFE against ACCIDENTAL shrink; NEVER freeze INTENTIONAL shrink — an explicit clear()/bulk-forget passes
// {intentional:true} and is always allowed. Below `floor` records there is nothing worth protecting (a young store
// legitimately grows from ~0), so the guard is inert until the store holds real content. PURE.

export function makeShrinkGuard({ ratio = 0.5, floor = 8 } = {}) {
  return {
    ratio,
    floor,
    // ok:false means "do NOT overwrite the durable copy — keep the last good". reason is human-readable for a log.
    check(prevCount, nextCount, { intentional = false } = {}) {
      const prev = Number(prevCount) || 0;
      const next = Number(nextCount) || 0;
      if (intentional) return { ok: true, reason: "intentional" };
      if (prev < floor) return { ok: true, reason: "below floor" };          // young store: nothing to protect yet
      if (next >= ratio * prev) return { ok: true, reason: "within ratio" };  // normal growth / gradual forget
      return { ok: false, reason: `suspicious shrink: ${next} < ${Math.round(ratio * 100)}% of last good ${prev}` };
    },
  };
}
