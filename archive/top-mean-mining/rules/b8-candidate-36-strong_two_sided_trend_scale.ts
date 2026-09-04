export default (cand, event) => cand.score * (cand.ema200Above ? 1.1 : 0.9);
