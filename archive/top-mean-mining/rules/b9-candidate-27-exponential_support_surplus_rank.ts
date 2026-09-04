export default (cand, event) => cand.score * (1 - Math.exp(-0.08 * Math.max(0, cand.activePairCount - 25)));
