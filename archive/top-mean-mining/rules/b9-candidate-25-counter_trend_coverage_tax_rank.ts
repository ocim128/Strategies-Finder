export default (cand, event) => cand.signedVotes / (cand.activePairCount + (cand.ema200Above ? 0 : 8));
