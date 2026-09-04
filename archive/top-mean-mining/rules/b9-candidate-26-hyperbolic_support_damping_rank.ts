export default (cand, event) => cand.score / (1 + Math.exp(-0.15 * (cand.activePairCount - 44)));
