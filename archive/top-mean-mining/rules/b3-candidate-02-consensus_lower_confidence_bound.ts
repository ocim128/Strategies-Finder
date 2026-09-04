export default (cand, event) => cand.score - 1.0 / Math.sqrt(cand.activePairCount);
