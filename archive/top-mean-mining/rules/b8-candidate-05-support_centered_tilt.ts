export default (cand, event) => cand.score + 0.04 * Math.tanh((cand.activePairCount - 45) / 10);
