export default (cand, event) => event.breadth < 0.62 ? cand.score >= 0.80 : true;
