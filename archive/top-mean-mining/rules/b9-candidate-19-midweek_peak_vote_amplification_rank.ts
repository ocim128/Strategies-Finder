export default (cand, event) => cand.score * ((event.dow >= 2 && event.dow <= 4) ? (cand.signedVotes >= 24 ? 1.12 : 0.92) : 1.0);
