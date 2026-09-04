export default (cand, event) => cand.score + (cand.ema200Above ? 1 : -1) * 3 * Math.pow(cand.breadth - 0.68, 2);
