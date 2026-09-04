export default (cand, event) => cand.activePairCount >= 40 || (cand.ema200Above && cand.signedVotes >= 18);
