export default (cand, event) => cand.score * (1 + (cand.ema200Above ? 0.25 : -0.10) * Math.max(0, (event.breadth ?? 0.67) - 0.50));
