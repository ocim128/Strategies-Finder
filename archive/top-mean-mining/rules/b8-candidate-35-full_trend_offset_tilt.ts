export default (cand, event) => cand.score + 0.1 * (cand.ema200Above ? 1 : -1);
