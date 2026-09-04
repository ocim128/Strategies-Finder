export default (cand, event) => event.regime === "bearish" ? cand.score * (cand.activePairCount >= 48 && cand.signedVotes >= 15 ? 1.15 : 0.85) : cand.score;
