export default (cand, event) => cand.score * (1 + 0.06 * (cand.ema200Above ? 1 : 0) * ((event.breadth ?? 0.67) >= 0.6 ? 1 : 0));
