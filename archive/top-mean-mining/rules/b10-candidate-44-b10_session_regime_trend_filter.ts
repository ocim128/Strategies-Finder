export default (cand, event) => event.hour >= 16 ? cand.regime !== event.regime && cand.ema200Above : cand.regime === event.regime && !cand.ema200Above;
