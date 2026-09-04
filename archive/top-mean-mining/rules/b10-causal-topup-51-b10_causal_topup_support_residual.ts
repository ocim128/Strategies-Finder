export default (cand, event) => cand.score + 0.006 * (cand.signedVotes - 0.75 * cand.activePairCount);
