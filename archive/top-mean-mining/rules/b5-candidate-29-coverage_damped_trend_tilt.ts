export default (cand, event) => cand.score * (1 + 0.08 * (cand.ema200Above ? 1 : -1) * Math.min(1, cand.activePairCount / 44));
