export default (cand, event) => (cand.signedVotes + 3) / (cand.activePairCount + 10);
