export default (cand, event) => cand.signedVotes / Math.pow(cand.activePairCount, 1.5);
