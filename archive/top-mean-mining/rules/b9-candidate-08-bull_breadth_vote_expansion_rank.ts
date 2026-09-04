export default (cand, event) => cand.score * (1 + (event.breadth >= 0.70 ? (cand.signedVotes >= 25 ? 0.18 : -0.10) : 0));
