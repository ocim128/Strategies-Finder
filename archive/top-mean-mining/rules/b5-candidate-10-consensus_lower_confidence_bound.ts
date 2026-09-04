export default (cand, event) => cand.score - 1.2 / Math.sqrt(cand.activePairCount);
