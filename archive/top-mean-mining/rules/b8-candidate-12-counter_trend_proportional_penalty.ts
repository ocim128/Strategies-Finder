export default (cand, event) => cand.score - 0.05 * (1 - cand.score) * (cand.ema200Above ? 0 : 1);
