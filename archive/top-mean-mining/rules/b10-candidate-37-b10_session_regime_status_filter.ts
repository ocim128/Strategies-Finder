export default (cand, event) => event.hour < 12 ? cand.regime === event.regime && cand.shortEligible : cand.regime !== event.regime && cand.ema200Above;
