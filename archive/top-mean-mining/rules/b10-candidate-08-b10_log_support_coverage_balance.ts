export default (cand, event) => Math.log1p(cand.signedVotes) - 0.08 * Math.sqrt(cand.activePairCount);
