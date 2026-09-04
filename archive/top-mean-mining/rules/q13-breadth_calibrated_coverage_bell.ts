export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.activePairCount - (44 + 24 * cand.breadth)) / 8, 2));
