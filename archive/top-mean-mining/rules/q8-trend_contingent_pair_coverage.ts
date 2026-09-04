export default (cand, event) => cand.activePairCount >= (cand.ema200Above ? 55 : 70);
