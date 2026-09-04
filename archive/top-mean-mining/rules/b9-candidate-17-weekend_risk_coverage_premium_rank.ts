export default (cand, event) => cand.score * (event.dow === 5 ? (cand.activePairCount >= 48 ? 1.14 : 0.88) : 1.0);
