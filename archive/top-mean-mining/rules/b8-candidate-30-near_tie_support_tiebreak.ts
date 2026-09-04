export default (cand, event) => cand.score + 0.02 * Math.max(-1, Math.min(1, (cand.activePairCount - 44) / 20));
