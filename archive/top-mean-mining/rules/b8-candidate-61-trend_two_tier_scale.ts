export default (cand, event) => cand.score * (cand.ema200Above ? (cand.signedVotes >= 15 ? 1.08 : 0.96) : (cand.signedVotes >= 30 ? 1 : 0.88));
