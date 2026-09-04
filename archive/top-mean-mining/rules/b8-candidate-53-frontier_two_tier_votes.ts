export default (cand, event) => cand.activePairCount >= 44 ? cand.signedVotes : cand.signedVotes * 0.6;
