export default (cand, event) => 1 - Math.abs(cand.score - (cand.ema200Above ? 0.72 : 0.42));
