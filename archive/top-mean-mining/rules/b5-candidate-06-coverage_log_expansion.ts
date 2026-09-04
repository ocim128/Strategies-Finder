export default (cand, event) => cand.score * (1 + 0.25 * Math.log(cand.activePairCount / 44));
