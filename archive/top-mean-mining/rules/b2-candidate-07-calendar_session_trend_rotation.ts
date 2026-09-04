export default (cand, event) => cand.score * (event.dow === 2 || event.dow === 4 ? (event.hour < 12 ? (cand.ema200Above ? 1.12 : 0.94) : (cand.ema200Above ? 0.94 : 1.12)) : 1);
