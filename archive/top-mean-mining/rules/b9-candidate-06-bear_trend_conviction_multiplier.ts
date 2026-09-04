export default (cand, event) => event.regime === "bearish" ? cand.score * (cand.ema200Above ? 1.25 : 0.75) : cand.score;
