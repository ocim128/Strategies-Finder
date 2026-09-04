export default (cand, event) => cand.score * (event.hour < 12 ? Math.min(1, cand.activePairCount / 45) : 1);
