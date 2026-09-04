export default (cand, event) => event.regime === "bearish" ? cand.activePairCount >= 48 : true;
