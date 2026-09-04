export default (cand, event) => !cand.ema200Above ? cand.activePairCount >= 55 : true;
