export default (cand, event) => event.regime === "bearish" ? cand.score * (cand.ema200Above ? 1.15 : 0.85) : cand.score;
