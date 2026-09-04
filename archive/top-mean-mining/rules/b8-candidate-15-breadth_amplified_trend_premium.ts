export default (cand, event) => cand.score * (1 + 0.3 * (cand.ema200Above ? Math.max(0, (event.breadth ?? 0.67) - 0.55) : 0));
