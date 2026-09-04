export default (cand, event) => (cand.signedVotes >= 15 ? 1 : 0.85) * cand.score * (cand.ema200Above ? 1 : 0.95);
