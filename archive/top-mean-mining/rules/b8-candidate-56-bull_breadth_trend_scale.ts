export default (cand, event) => (event.breadth ?? 0) >= 0.7 ? cand.score * (cand.ema200Above ? 1.1 : 0.9) : cand.score;
