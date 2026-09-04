export default (cand, event) => cand.ema200Above ? cand.signedVotes : cand.signedVotes / 2;
