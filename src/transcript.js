// Appends a transcript turn in place, capping memory/token growth for long
// sessions by dropping the oldest turns once the cap is exceeded.

const DEFAULT_MAX_TURNS = 500;

function appendTurn(transcript, turn, maxTurns = DEFAULT_MAX_TURNS) {
  transcript.push(turn);
  if (transcript.length > maxTurns) transcript.splice(0, transcript.length - maxTurns);
  return transcript;
}

module.exports = { appendTurn, DEFAULT_MAX_TURNS };
