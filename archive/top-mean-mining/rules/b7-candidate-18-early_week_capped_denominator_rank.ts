export default (cand, event) => event.dow <= 3 ? cand.signedVotes / Math.min(cand.activePairCount, 45) : cand.score;
