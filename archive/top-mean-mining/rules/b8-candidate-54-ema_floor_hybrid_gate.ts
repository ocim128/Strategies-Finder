export default (cand, event) => cand.ema200Above ? true : (cand.activePairCount >= 50 && cand.signedVotes >= 12);
