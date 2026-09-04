export default (cand, event) => (event.breadth ?? 0.67) >= 0.67 || cand.ema200Above;
