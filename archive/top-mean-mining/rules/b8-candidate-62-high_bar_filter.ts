export default (cand, event) => cand.signedVotes >= 30 || (cand.ema200Above && cand.activePairCount >= 50);
