export default (cand, event) => (cand.ema200Above ? cand.signedVotes : Math.max(0, cand.signedVotes - 6)) / cand.activePairCount;
