export default (cand, event) => event.dow === 1 ? cand.score * (cand.ema200Above ? 1.04 : 0.96) : cand.score;
