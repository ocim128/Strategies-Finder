export default (cand, event) => cand.signedVotes - Math.pow(Math.max(0, 55 - cand.activePairCount), 2) / 22;
