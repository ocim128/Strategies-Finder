export default (cand, event) => cand.score * (1 + 0.3 * ((event.breadth ?? 0.67) - 0.67) * (cand.ema200Above ? 1 : -1));
