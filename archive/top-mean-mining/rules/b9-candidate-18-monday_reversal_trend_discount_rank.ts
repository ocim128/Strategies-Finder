export default (cand, event) => cand.score * (event.dow === 1 ? (cand.ema200Above ? 1.05 : 0.92) : 1.0);
