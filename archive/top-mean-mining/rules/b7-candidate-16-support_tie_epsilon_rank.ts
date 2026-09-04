export default (cand, event) => cand.score - 0.000001 * Math.max(0, 44 - cand.activePairCount);
