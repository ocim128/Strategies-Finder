export default (cand, event) => cand.signedVotes >= 20 ? cand.signedVotes : cand.signedVotes * 0.5;
