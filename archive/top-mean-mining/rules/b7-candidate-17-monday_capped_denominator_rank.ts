export default (cand, event) => event.dow === 1 ? cand.signedVotes / Math.min(cand.activePairCount, 41) : cand.score;
