export default (cand, event) => event.breadth !== null && event.breadth < 0.45 ? cand.signedVotes >= 18 : true;
