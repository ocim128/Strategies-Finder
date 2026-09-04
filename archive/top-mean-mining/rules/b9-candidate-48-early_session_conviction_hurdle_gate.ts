export default (cand, event) => event.hour <= 13 ? (cand.signedVotes >= 20 ? true : cand.ema200Above) : true;
