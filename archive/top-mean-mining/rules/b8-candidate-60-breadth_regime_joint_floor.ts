export default (cand, event) => (event.breadth ?? 0.5) < 0.5 ? cand.activePairCount >= 50 : (cand.ema200Above || cand.signedVotes >= 22);
