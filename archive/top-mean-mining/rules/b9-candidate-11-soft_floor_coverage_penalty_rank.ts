export default (cand, event) => cand.signedVotes / (cand.activePairCount + Math.max(0, 45 - cand.activePairCount) * 1.2);
