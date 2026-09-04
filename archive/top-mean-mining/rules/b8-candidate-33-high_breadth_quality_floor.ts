export default (cand, event) => event.breadth !== null && event.breadth >= 0.7 ? cand.activePairCount >= 50 || cand.ema200Above : true;
