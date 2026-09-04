export default (cand, event) => cand.signedVotes / Math.pow(cand.activePairCount, cand.ema200Above ? 0.6 : 1.3);
