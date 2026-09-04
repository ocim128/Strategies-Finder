export default (cand, event) => cand.signedVotes - 1.5 * Math.max(0, 45 - cand.activePairCount);
