export default (cand, event) => cand.signedVotes / Math.min(cand.activePairCount, cand.ema200Above ? 79 : 45);
