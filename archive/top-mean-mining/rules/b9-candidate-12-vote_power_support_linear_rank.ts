export default (cand, event) => Math.pow(cand.signedVotes, 1.15) / cand.activePairCount;
