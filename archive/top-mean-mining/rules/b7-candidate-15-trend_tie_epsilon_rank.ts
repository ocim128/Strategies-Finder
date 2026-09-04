export default (cand, event) => cand.score + (cand.ema200Above ? 0.000001 : 0);
