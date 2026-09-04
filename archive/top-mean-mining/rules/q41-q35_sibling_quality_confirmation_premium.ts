export default (cand, event) => cand.score + (cand.ema200Above ? (cand.activePairCount >= 50 ? 0.20 : 0) : 0);
