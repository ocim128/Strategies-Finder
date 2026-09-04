export default (cand, event) => event.regime !== "bullish" || cand.activePairCount >= 45;
