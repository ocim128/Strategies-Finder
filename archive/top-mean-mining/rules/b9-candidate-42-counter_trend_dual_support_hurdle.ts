export default (cand, event) => cand.ema200Above ? true : (cand.activePairCount >= 52 && cand.signedVotes >= 24);
