export default (cand, event) => event.hour === 12 ? cand.score * (cand.ema200Above ? 1.02 : 0.98) : cand.score;
