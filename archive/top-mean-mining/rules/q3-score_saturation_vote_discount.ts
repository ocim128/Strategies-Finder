export default (cand, event) => cand.score * (1 - Math.exp(-cand.signedVotes / 10));
