export default (cand, event) => event.regime === "bearish" ? (cand.activePairCount >= 48 && cand.signedVotes >= 15) : true;
