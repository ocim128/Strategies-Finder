export default (cand, event) => event.regime === "bearish" ? (cand.ema200Above && cand.activePairCount >= 45) : true;
