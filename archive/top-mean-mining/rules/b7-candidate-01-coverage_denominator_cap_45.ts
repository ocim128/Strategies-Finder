export default (cand, event) => cand.signedVotes / Math.min(cand.activePairCount, 45);
