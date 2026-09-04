export default (cand, event) => Math.floor(event.decisionTimeSec / 86400) % 30 >= 27 ? cand.signedVotes / Math.min(cand.activePairCount, 41) : cand.score;
