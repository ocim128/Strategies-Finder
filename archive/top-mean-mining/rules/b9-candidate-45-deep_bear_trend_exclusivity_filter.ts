export default (cand, event) => event.breadth < 0.50 ? cand.ema200Above : true;
