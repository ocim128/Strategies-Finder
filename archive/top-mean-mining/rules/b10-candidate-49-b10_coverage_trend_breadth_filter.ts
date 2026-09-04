export default (cand, event) => cand.ema200Above === (cand.activePairCount <= 48) ? cand.breadth >= 0.66 : cand.breadth <= 0.74;
