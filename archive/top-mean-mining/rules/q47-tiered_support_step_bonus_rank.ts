export default (cand, event) => cand.score + (cand.activePairCount >= 52 ? 0.08 : (cand.activePairCount >= 46 ? 0.03 : -0.05));
