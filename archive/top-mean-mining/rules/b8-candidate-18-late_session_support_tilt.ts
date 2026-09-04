export default (cand, event) => event.hour >= 16 ? cand.score * (cand.activePairCount >= 45 ? 1.03 : 0.97) : cand.score;
