export default (cand, event) => cand.score * (cand.activePairCount / (cand.activePairCount + 8)) + 0.36 * (8 / (cand.activePairCount + 8));
