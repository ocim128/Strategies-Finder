export default (cand, event) => cand.signedVotes / Math.min(cand.activePairCount, event.breadth > 0.71 ? 44 : 55);
