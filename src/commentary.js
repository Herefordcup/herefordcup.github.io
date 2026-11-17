const PHRASE_ALLOWLIST = Object.freeze({
  clean: Object.freeze({
    clean_steady: 'A composed finish settled the contest.',
    clean_clinical: 'The result was secured with a disciplined close.',
  }),
  playful: Object.freeze({
    playful_pressure: 'The pressure stayed on until the result was settled.',
    playful_scoreboard: 'The scoreboard gets the final word.',
  }),
  ruthless: Object.freeze({
    ruthless_closed: 'The door closed, and the scoreboard did not blink.',
    ruthless_final: 'No spin needed; the result stands on its own.',
  }),
});

export function phraseIdsForTone(tone) {
  return Object.keys(PHRASE_ALLOWLIST[tone] ?? {});
}

export function composeCommentary(result, tone, phraseId) {
  const phrase = PHRASE_ALLOWLIST[tone]?.[phraseId];
  if (!phrase) throw new Error('Invalid commentary phrase identifier.');
  return `${result}. ${phrase}`;
}
