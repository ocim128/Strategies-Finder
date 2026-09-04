export default (cand, event) => event.breadth >= 0.72 ? cand.signedVotes >= 24 : true;
