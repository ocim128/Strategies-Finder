export default (cand, event) => cand.ema200Above && (event.breadth === null || event.breadth < 0.78);
