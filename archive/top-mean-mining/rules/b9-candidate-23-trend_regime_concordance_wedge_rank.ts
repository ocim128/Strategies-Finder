export default (cand, event) => cand.score * (cand.regime === event.regime ? (cand.ema200Above ? 1.15 : 1.0) : 0.85);
