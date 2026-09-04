export default (cand, event) => event.dow === 1 ? (cand.ema200Above ? true : cand.signedVotes >= 25) : true;
