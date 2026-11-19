const PHRASE_ALLOWLIST = Object.freeze({
  clean: Object.freeze({
    clean_steady: 'A composed finish settled the contest.',
    clean_clinical: 'The result was secured with a disciplined close.',
    clean_complete: 'The scorecard confirms a complete performance.',
    clean_decisive: 'A decisive finish put the result beyond doubt.',
    clean_halved_even: 'The scorecard confirms an evenly shared match.',
    clean_halved_complete: 'The full card ended with the point shared.',
  }),
  playful: Object.freeze({
    playful_excuses: 'The winners get bragging rights; the losers get first crack at the excuses.',
    playful_group_chat: 'Bragging rights secured. The scorecard has entered the group chat.',
    playful_recount: 'The card is signed; recount requests have been denied by the scorecard.',
    playful_character: 'One side gets the win. The other gets a little character development.',
    playful_receipts: 'The scorecard kept the receipts, and it is not accepting revisions.',
    playful_cart_ride: 'The result is on the card. The wheels are officially loose.',
    playful_halved_claims: 'Nobody gets the win, so the scorecard gets the last laugh.',
    playful_halved_brags: 'The match was halved; the scorecard declined to pick a favorite.',
  }),
  ruthless: Object.freeze({
    ruthless_no_appeal: 'The scorecard leaves no appeal and even less sympathy.',
    ruthless_character: 'One side earned the win. The other earned character development.',
    ruthless_receipts: 'The scorecard kept every receipt. None of them favor the losing side.',
    ruthless_verdict: 'The verdict arrived, and the excuses were ruled inadmissible.',
    ruthless_resume: 'Put it on the winners’ résumé and file the other copy under hard lessons.',
    ruthless_silence: 'The result is official. The scorecard has closed comments.',
    ruthless_halved_stalemate: 'The full card produced no winner and no appeal.',
    ruthless_halved_brags: 'No winner, no loser, and no room for creative scorekeeping.',
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
