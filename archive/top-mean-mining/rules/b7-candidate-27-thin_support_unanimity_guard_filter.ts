export default (cand, event) => !(cand.score >= 0.85 && cand.activePairCount < 42);
