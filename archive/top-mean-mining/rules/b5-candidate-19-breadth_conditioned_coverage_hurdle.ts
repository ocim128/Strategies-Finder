export default (cand, event) => (event.breadth ?? 0.67) < 0.72 || cand.activePairCount >= 44;
