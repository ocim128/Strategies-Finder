export default (cand, event) => cand.score + 0.004 * (cand.activePairCount - 44);
