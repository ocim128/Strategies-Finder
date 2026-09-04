export default (cand, event) => !cand.ema200Above ? cand.activePairCount >= 48 : true;
