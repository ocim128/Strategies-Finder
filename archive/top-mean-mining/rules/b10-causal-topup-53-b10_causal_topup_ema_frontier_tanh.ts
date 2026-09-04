export default (cand, event) => cand.score * (1 + 0.19 * Math.tanh((cand.activePairCount - 46) / 3) * (cand.ema200Above ? 1 : -1));
