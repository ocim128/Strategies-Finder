export default (cand, event) => cand.score * (cand.activePairCount >= 48 ? 1.03 : 0.97);
