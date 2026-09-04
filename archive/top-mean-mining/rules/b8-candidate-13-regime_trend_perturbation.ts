export default (cand, event) => event.regime === "bearish" ? cand.score + (cand.ema200Above ? 0.02 : -0.02) : cand.score + (cand.ema200Above ? 0.005 : -0.005);
