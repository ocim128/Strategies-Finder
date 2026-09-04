export default (cand, event) => cand.score + (event.regime === "bearish" ? (cand.ema200Above ? 0.15 : -0.15) : 0);
