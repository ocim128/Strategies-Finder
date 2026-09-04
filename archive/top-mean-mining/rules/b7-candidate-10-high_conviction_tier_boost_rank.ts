export default (cand, event) => cand.score * (cand.signedVotes >= 30 ? 1.15 : 1);
