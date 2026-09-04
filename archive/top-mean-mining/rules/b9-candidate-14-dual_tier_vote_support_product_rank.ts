export default (cand, event) => cand.score * (cand.signedVotes >= 25 ? 1.10 : 0.92) * (cand.activePairCount >= 46 ? 1.08 : 0.94);
