export default (cand, event) => event.breadth >= 0.72 ? (cand.ema200Above && cand.activePairCount >= 46) : true;
