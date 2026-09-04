export default (cand, event) => cand.score + 0.02 * (cand.ema200Above ? 1 : 0) - 0.02 * ((event.breadth ?? 0) > 0.75 && !cand.ema200Above ? 1 : 0);
