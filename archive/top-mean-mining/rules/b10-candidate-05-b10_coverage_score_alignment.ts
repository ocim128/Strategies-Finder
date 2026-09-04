export default (cand, event) => 1 - Math.abs(cand.score - Math.tanh(cand.activePairCount / 60));
