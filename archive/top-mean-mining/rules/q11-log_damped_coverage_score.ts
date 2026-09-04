export default (cand, event) => cand.signedVotes / Math.log2(cand.activePairCount);
