export default (cand, event) => cand.score * (1 + 0.3 * ((event.regime === "bearish" && cand.ema200Above) ? 1 : 0));
