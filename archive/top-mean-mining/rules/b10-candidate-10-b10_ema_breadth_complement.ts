export default (cand, event) => cand.score * (cand.ema200Above ? 1 - 0.5 * cand.breadth : Math.sqrt(cand.breadth));
