// The tournament schedule is entered in Eastern time, not the organizer's browser zone.
const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function scrambleLocalStart(instant) {
  const parts = Object.fromEntries(easternClock.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const beforeFinal = status => status === 'scheduled' || status === 'live';

// Selecting a tee sets the whole tree to live. Look for evidence of play instead.
// The RPC repeats the authoritative checks under lock; this snapshot is for the UI.
export function scrambleLockReason(data, tournamentId, sessionId) {
  const tournament = data.tournaments.find(t => t.id === tournamentId);
  if (!tournament) return 'Select a tournament to plan a lineup.';
  if (!['setup', 'open', 'live'].includes(tournament.status) || data.legacyEditions.some(e => e.source_tournament_id === tournamentId)) {
    return 'Lineup locked: this tournament is closed or archived.';
  }
  if (!sessionId) return '';
  const session = data.scrambleSessions.find(s => s.id === sessionId && s.tournament_id === tournamentId);
  if (!session) return 'Lineup unavailable. Reload the page to verify this saved lineup before editing.';
  if (!beforeFinal(session.status)) return 'Lineup locked: the session is final or closed.';
  const squads = session.texas_scramble_squads;
  const incomplete = 'Lineup is read-only: its saved squads or scorecards could not be verified.';
  if (!Array.isArray(squads) || !squads.length) return incomplete;
  for (const squad of squads) {
    const match = data.matches.find(m => m.id === squad.match_id && m.tournament_id === tournamentId);
    const segment = match?.match_segments?.find(s => s.id === squad.segment_id);
    if (match?.format !== 'scramble' || segment?.format !== 'scramble' || match.match_segments.length !== 1
        || !Array.isArray(squad.texas_scramble_hole_scores)) return incomplete;
    if (![squad.status, match.status, segment.status].every(beforeFinal)
        || [squad.finalized_at, squad.gross_total, squad.net_score, squad.points].some(v => v != null)) {
      return 'Lineup locked: a squad or match is final or closed.';
    }
    if (squad.texas_scramble_hole_scores.length || segment.holes_played !== 0 || segment.differential !== 0 || segment.point_value !== 0
        || data.rounds.some(round => round.match_id === match.id)) return 'Lineup locked: play has started on a squad scorecard.';
    if (data.legacyEditions.some(e => e.legacy_results?.some(r => r.source_match_id === match.id || r.source_segment_id === segment.id))) {
      return 'Lineup locked: a squad result is archived.';
    }
    const players = squad.texas_scramble_squad_players;
    if (![2, 4].includes(squad.squad_size) || !Array.isArray(players) || players.length !== squad.squad_size
        || !players.every((_, i) => players.some(p => p.playing_order === i + 1 && p.user_id))) return incomplete;
  }
  return '';
}
