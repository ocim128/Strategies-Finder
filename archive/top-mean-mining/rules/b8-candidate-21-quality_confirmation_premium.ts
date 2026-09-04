export default (cand, event) => cand.score * (1 + 0.25 * (cand.ema200Above ? 1 : 0) * (cand.activePairCount >= 50 ? 1 : 0));
