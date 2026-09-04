export default (cand, event) => cand.ema200Above ? true : cand.breadth >= 0.70;
