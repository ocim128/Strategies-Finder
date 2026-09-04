export default (cand, event) => cand.score * ((event.regime === "bearish" && !cand.ema200Above) ? 0.9 : ((event.regime === "bullish" && cand.ema200Above) ? 1.05 : 1));
