export default (cand, event) => cand.signedVotes * Math.min(1.2, cand.activePairCount / 45);
