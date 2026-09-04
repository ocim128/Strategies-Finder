export default (cand, event) => cand.ema200Above ? cand.score >= 0.70 : cand.score >= 0.85;
