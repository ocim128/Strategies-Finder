export default (cand, event) => cand.score * (1 + (cand.ema200Above ? 1 : -1) * (event.breadth ?? 0.67));
