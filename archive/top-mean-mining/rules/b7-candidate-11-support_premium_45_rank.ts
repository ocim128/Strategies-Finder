export default (cand, event) => cand.score + (cand.activePairCount >= 45 ? 0.05 : 0);
