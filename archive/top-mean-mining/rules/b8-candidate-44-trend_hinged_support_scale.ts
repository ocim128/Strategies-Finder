export default (cand, event) => cand.score * (1 + 0.15 * (cand.ema200Above ? 1 : -1) * Math.max(0, (50 - cand.activePairCount) / 50));
