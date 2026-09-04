export default (cand, event) => event.regime === "bullish" ? cand.score * (cand.activePairCount >= 45 ? 1.03 : 0.97) : cand.score * (cand.ema200Above ? 1.03 : 0.97);
