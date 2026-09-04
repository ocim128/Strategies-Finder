export default (cand, event) => cand.score + 0.006 * (1 - Math.abs(cand.activePairCount - (cand.regime === "bullish" ? 45 : 52)));
