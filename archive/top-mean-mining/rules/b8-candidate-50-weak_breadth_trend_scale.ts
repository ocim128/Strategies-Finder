export default (cand, event) => (event.breadth ?? 1) < 0.5 ? cand.score * (cand.ema200Above ? 1.12 : 0.88) : cand.score;
