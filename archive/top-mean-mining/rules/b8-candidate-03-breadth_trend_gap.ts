export default (cand, event) => cand.score * (1 + 0.15 * (cand.ema200Above ? 1 : -1) * (1 - (event.breadth ?? 0.67)));
