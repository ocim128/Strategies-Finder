export default (cand, event) => !(cand.signedVotes >= 20 && cand.activePairCount < 55);
