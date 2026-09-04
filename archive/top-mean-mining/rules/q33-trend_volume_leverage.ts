export default (cand, event) => cand.score * Math.sqrt(cand.signedVotes + (cand.ema200Above ? 12 : 0));
