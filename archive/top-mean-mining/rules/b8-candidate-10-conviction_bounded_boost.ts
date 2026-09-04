export default (cand, event) => cand.score * (cand.signedVotes >= 25 ? 1.04 : 0.98);
