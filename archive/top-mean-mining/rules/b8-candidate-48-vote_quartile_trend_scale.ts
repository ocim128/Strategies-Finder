export default (cand, event) => cand.score * (1 + 0.12 * (cand.ema200Above ? Math.min(1, cand.signedVotes / 30) : -Math.min(1, cand.signedVotes / 30)));
