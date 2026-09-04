export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.activePairCount - (event.hour < 12 ? 44 : 52)) / 5, 2));
