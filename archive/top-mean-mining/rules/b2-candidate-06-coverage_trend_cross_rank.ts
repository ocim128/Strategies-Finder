export default (cand, event) => cand.score * (1 + 0.18 * (cand.ema200Above ? 1 : -1) * ((cand.activePairCount - 60) / 20));
