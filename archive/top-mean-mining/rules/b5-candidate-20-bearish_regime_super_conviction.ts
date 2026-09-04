export default (cand, event) => event.regime !== "bearish" || cand.score >= 0.85;
