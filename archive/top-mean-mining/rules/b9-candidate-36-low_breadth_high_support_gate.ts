export default (cand, event) => event.breadth < 0.60 ? cand.activePairCount >= 48 : true;
