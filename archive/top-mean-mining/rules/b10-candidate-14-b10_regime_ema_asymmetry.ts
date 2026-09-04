export default (cand, event) => cand.score * (cand.ema200Above ? (cand.regime === "bullish" ? 0.96 : 1.12) : (cand.regime === "bullish" ? 1.08 : 0.90));
