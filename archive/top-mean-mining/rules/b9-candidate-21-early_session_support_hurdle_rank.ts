export default (cand, event) => cand.score * (event.hour <= 14 ? (cand.activePairCount >= 46 ? 1.10 : 0.90) : 1.0);
