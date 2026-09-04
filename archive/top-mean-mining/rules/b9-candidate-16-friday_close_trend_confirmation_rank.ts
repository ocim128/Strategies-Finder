export default (cand, event) => cand.score * (event.dow === 5 ? (cand.ema200Above ? 1.18 : 0.82) : 1.0);
