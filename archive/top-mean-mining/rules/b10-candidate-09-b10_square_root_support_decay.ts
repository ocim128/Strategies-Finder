export default (cand, event) => Math.sqrt(cand.signedVotes) * (1 - 0.012 * cand.activePairCount);
