export default (cand, event) => event.regime === "bearish" ? cand.score * (cand.activePairCount >= 50 ? 1.20 : 0.80) : cand.score;
