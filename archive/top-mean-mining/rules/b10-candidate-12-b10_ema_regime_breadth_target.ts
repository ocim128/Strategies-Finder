export default (cand, event) => cand.score * (1 - Math.abs(cand.breadth - (cand.ema200Above === (cand.regime === "bullish") ? 0.72 : 0.58)));
