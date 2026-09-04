export default (cand, event) => event.regime === "bullish" ? cand.score >= 0.44 && cand.breadth <= event.breadth : cand.score >= 0.32 && cand.breadth >= event.breadth;
