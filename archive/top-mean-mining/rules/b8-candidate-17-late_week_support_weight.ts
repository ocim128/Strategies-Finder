export default (cand, event) => cand.score * (event.dow >= 4 ? Math.min(1.5, cand.activePairCount / 40) : 1);
