export default (cand, event) => cand.activePairCount >= 45 && (cand.ema200Above || cand.signedVotes >= 20);
