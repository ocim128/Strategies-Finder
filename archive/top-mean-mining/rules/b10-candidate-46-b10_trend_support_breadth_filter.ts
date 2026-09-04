export default (cand, event) => cand.ema200Above ? cand.signedVotes >= 22 && cand.breadth >= 0.68 : cand.signedVotes >= 16 && cand.breadth <= 0.72;
