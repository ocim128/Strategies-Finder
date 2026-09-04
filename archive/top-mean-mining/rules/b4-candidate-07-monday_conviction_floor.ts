export default (cand, event) => event.dow === 1 ? cand.signedVotes >= 20 : true;
