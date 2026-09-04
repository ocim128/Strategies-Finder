export default (cand, event) => Math.max(0, cand.signedVotes - 10) / cand.activePairCount;
