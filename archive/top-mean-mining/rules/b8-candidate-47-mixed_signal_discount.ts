export default (cand, event) => cand.score * (cand.ema200Above || cand.signedVotes >= 25 ? 1.06 : 0.94);
