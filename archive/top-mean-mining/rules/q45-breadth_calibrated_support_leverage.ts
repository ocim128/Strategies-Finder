export default (cand, event) => cand.score * (1 + 0.20 * (cand.activePairCount >= 48 ? 1 : -1) * (0.75 - event.breadth));
