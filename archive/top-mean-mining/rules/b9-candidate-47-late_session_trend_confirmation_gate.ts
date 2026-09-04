export default (cand, event) => event.hour >= 19 ? cand.ema200Above : true;
