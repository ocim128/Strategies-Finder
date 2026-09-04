export default (cand, event) => cand.score * (cand.ema200Above ? (1 + Math.min(0.25, Math.pow(cand.signedVotes / 35, 2) * 0.25)) : 0.88);
