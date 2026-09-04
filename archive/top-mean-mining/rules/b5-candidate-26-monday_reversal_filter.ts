export default (cand, event) => event.dow !== 1 || cand.ema200Above || cand.score >= 0.88;
