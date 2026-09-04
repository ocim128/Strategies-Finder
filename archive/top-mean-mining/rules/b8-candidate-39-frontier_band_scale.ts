export default (cand, event) => cand.score * (cand.activePairCount >= 55 ? 1.1 : (cand.activePairCount >= 40 ? 1 : 0.9));
