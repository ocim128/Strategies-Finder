export default (cand, event) => cand.signedVotes - 0.5 * Math.max(0, 55 - cand.activePairCount);
