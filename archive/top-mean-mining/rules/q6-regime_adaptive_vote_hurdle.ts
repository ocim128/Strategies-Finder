export default (cand, event) => (event.breadth ?? 0.67) >= 0.67 ? cand.signedVotes >= 15 : cand.signedVotes >= 8;
