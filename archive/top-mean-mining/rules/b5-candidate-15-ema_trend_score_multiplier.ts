export default (cand, event) => cand.score * (cand.ema200Above ? 1.06 : 0.94);
