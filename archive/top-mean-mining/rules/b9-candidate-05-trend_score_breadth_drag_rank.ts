export default (cand, event) => cand.score * (1 + 0.25 * (cand.ema200Above ? 1 : -1) * (0.75 - event.breadth));
