export default (cand, event) => cand.score * (1 + 0.5 * ((event.breadth ?? 0.67) - 0.50) * Math.log(cand.activePairCount / 40));
