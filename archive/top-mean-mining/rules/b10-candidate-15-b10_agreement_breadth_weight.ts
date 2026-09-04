export default (cand, event) => cand.score * (cand.ema200Above === (cand.regime === "bullish") ? 1 - 0.25 * cand.breadth : 0.85 + 0.20 * cand.breadth);
