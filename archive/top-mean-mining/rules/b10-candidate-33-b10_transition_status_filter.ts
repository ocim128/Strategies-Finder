export default (cand, event) => cand.shortEligible === (cand.ema200Above !== (cand.regime === event.regime));
