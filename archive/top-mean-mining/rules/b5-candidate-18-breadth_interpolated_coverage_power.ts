export default (cand, event) => cand.signedVotes / Math.pow(cand.activePairCount, event.breadth ?? 0.67);
