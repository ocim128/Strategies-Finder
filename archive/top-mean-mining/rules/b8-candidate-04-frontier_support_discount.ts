export default (cand, event) => cand.score * Math.min(1, cand.activePairCount / 45);
