export default (cand, event) => cand.signedVotes / (cand.activePairCount + Math.max(0, 48 - cand.activePairCount) * 0.8);
