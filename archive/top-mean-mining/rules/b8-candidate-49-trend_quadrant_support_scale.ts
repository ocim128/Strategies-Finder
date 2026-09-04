export default (cand, event) => cand.score * (((cand.ema200Above ? 1 : -1) * (cand.activePairCount - 44)) >= 0 ? 1.12 : 0.88);
