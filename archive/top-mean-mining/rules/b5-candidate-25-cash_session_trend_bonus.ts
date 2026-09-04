export default (cand, event) => cand.score * (event.hour >= 12 && event.hour <= 20 ? (cand.ema200Above ? 1.05 : 0.95) : 1);
