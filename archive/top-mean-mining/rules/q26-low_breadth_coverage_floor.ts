export default (cand, event) => event.breadth < 0.62 ? cand.activePairCount >= 60 : true;
