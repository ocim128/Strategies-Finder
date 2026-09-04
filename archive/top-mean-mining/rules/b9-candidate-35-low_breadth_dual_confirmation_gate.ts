export default (cand, event) => event.breadth < 0.60 ? (cand.ema200Above && cand.signedVotes >= 18) : true;
