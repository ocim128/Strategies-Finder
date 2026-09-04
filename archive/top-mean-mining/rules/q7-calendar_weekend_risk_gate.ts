export default (cand, event) => event.dow !== 5 || cand.signedVotes >= 20;
