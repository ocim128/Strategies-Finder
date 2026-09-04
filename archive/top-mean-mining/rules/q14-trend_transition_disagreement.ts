export default (cand, event) => cand.score * (cand.ema200Above !== (cand.regime === "bullish") ? 1.16 : 0.92);
