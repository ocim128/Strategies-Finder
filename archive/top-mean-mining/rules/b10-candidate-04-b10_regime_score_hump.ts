export default (cand, event) => 1 - Math.pow(Math.abs(cand.score - (cand.regime === "bullish" ? 0.60 : 0.45)), 3);
