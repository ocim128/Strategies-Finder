export default (cand, event) => cand.score * (0.9 + 0.2 * (cand.ema200Above ? 1 : 0) * Math.min(1, cand.signedVotes / 25));
