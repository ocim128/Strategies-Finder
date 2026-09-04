export default (cand, event) => (cand.ema200Above ? 1 : 0.85) * cand.signedVotes / Math.sqrt(cand.activePairCount);
