export default (cand, event) => event.breadth < 0.50 ? cand.activePairCount >= 46 : true;
