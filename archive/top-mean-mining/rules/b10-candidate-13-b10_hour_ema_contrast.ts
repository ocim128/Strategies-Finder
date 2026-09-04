export default (cand, event) => cand.score * (event.hour % 8 === 0 ? (cand.ema200Above ? 0.88 : 1.14) : (cand.ema200Above ? 1.06 : 0.94));
