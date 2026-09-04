export default (cand, event) => cand.score * (1 + 0.4 * Math.tanh((cand.activePairCount - 60) / 10));
