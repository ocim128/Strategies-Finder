export default (cand, event) => event.breadth === null || event.breadth < 0.55 ? cand.signedVotes >= 10 : true;
