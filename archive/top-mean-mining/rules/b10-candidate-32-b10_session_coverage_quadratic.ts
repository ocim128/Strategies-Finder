export default (cand, event) => cand.score * (event.hour < 12 ? 1 - 0.002 * Math.pow(cand.activePairCount - 44, 2) : 1 - 0.002 * Math.pow(cand.activePairCount - 52, 2));
