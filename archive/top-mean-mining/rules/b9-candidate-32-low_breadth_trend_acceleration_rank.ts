export default (cand, event) => event.breadth < 0.60 ? cand.score * (cand.ema200Above ? 1.22 : 0.78) : cand.score;
