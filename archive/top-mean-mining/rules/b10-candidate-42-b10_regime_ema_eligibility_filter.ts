export default (cand, event) => event.regime === "bullish" ? cand.ema200Above !== cand.shortEligible : cand.ema200Above === cand.shortEligible;
