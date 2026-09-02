// Population + rate coding between the outside world and the regions.
// inject(channel, value): drive a channel's neurons. readAction(): winner-take-all.
export function makeCodec({ channels, actions, driveScale = 12, rateDecay = 0.9, quietFloor = 0.5 }) {
  const drive = {};                  // neuronId -> persistent external current
  const rates = {};                  // action name -> decaying spike count
  const neuronAction = {};           // neuronId -> action name
  for (const [name, ids] of Object.entries(actions)) {
    rates[name] = 0;
    for (const id of ids) neuronAction[id] = name;
  }

  return {
    inject(name, value) {
      const ids = channels[name];
      if (!ids) throw new Error(`unknown channel: ${name}`);
      const current = value * driveScale;
      for (const id of ids) drive[id] = current;
    },
    driveInputs() { return drive; },
    // Clear external drive and the decaying action rates (used when settling between turns).
    reset() {
      for (const id in drive) drive[id] = 0;
      for (const name in rates) rates[name] = 0;
    },

    // Call once per tick with the indices that spiked.
    observe(spiked) {
      for (const name in rates) rates[name] *= rateDecay;
      for (const id of spiked) {
        const a = neuronAction[id];
        if (a !== undefined) rates[a] += 1;
      }
    },

    readAction() {
      // Winner-take-all over the motor-action populations. QUIET is a verdict, not a
      // population: if the winning action's rate is below quietFloor the decision region is
      // too quiet to act, so we report QUIET at zero confidence.
      let topName = null, top = -1, second = 0;
      for (const name in rates) {
        const v = rates[name];
        if (v > top) { second = top; top = v; topName = name; }
        else if (v > second) { second = v; }
      }
      if (topName === null || top < quietFloor) return { action: "QUIET", confidence: 0, rates: { ...rates } };
      const confidence = top > 0 ? (top - second) / top : 0;
      return { action: topName, confidence, rates: { ...rates } };
    },
  };
}
