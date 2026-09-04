export default (cand, event) => cand.signedVotes * (cand.ema200Above ? 1.1 : 0.9);
