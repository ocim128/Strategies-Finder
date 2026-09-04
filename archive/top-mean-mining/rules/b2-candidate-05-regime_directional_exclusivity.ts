export default (cand, event) => cand.score * (event.regime === "bullish" ? (cand.shortEligible ? 0.93 : 1.07) : (cand.shortEligible ? 1.07 : 0.93));
