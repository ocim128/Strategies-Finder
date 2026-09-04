export default (cand, event) => event.regime === "bearish" ? cand.activePairCount >= 52 : true;
