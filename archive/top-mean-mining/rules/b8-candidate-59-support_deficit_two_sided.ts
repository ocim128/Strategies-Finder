export default (cand, event) => cand.score * (1 - 0.25 * Math.max(0, (45 - cand.activePairCount) / 45) + 0.05 * Math.max(0, (cand.activePairCount - 55) / 24));
