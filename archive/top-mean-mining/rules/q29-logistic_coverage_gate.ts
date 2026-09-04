export default (cand, event) => cand.score / (1 + Math.exp(-(cand.activePairCount - 36) / 4));
