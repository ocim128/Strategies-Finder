export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.breadth - (event.breadth + (event.regime === "bullish" ? 0.04 : -0.04))) / 0.07, 2));
