export default (cand, event) => cand.score * (1 - 0.12 * Math.max(0, (45 - cand.activePairCount) / 45));
