export default (cand, event) => (event.dow === 1 || event.dow === 5) || cand.ema200Above;
