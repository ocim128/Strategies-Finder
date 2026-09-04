export default (cand, event) => event.dow === 5 ? (cand.ema200Above && cand.activePairCount >= 46) : true;
