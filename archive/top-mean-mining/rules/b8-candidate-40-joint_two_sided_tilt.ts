export default (cand, event) => cand.score * (1 + 0.2 * ((cand.signedVotes >= 25 && cand.ema200Above) ? 1 : ((cand.signedVotes < 10 && !cand.ema200Above) ? -1 : 0)));
