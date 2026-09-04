export default (cand, event) => Math.pow(cand.signedVotes, 1.20) / (cand.activePairCount + 5);
