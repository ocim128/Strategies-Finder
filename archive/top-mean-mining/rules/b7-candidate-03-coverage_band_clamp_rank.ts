export default (cand, event) => cand.signedVotes / Math.max(41, Math.min(cand.activePairCount, 45));
