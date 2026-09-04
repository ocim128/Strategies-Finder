export default (cand, event) => (cand.signedVotes - 2 * Math.sqrt(cand.activePairCount)) / cand.activePairCount;
