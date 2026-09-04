export default (cand, event) => cand.score * (cand.activePairCount >= 47 ? 1.13 : 0.87);
