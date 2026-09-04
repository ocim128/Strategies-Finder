export default (cand, event) => cand.score * (cand.ema200Above && cand.signedVotes >= 30 ? 1.05 : 1);
