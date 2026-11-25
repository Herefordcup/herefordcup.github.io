// Used only by the guarded, loopback-only disposable fixture. Privileged reads
// check persistence independently; only initial fixture creation may call an RPC.
export function organizerCheckData({ call, rpc, tournamentId, sessionId, courseId, adminId, squads }) {
  const read = (table, params) => call(`/rest/v1/${table}?${new URLSearchParams(params)}`);
  const eq = id => `eq.${id}`;
  async function lineup() {
    const [tournaments, sessions, matches, roster] = await Promise.all([
      read('tournaments', { id: eq(tournamentId), 'tournament_memberships.order': 'user_id',
        select: 'id,edition_year,status,tournament_memberships(user_id,team,role,status)' }),
      read('texas_scramble_sessions', { tournament_id: eq(tournamentId), order: 'id', select: '*' }),
      read('matches', { tournament_id: eq(tournamentId), order: 'id', 'match_segments.order': 'segment_number',
        'match_players.order': 'user_id', 'match_segments.match_segment_players.order': 'playing_order',
        select: '*,match_players(user_id,team),match_segments(*,match_segment_players(user_id,side,team,playing_order))' }),
      read('texas_scramble_squads', { session_id: eq(sessionId), order: 'label', 'texas_scramble_squad_players.order': 'playing_order', 'texas_scramble_hole_scores.order': 'hole_number',
        select: '*,texas_scramble_squad_players!texas_scramble_squad_players_squad_id_fkey(squad_id,session_id,user_id,playing_order),texas_scramble_hole_scores(*)' }),
    ]);
    if (tournaments.length !== 1) throw new Error('Expected one fixture tournament');
    return { tournament: tournaments[0], sessions, matches, roster };
  }
  async function history(matchIds) {
    const scope = { match_id: `in.(${matchIds.join(',')})`, order: 'event_sequence', select: '*' };
    const [corrections, results] = await Promise.all([read('team_score_correction_audit', scope), read('match_result_audit', scope)]);
    return { corrections, results };
  }
  async function newOutcomeMatch() {
    const match = { tournament_id: tournamentId, name: 'Organizer QA singles', session: 'Organizer QA', starts_at: '2027-03-19T19:00:00Z', course_id: courseId };
    const players = [squads[0], squads[2]].map((s, i) => ({ user_id: s.players[0].id, side: s.side, team: s.side, playing_order: i + 1 }));
    const segment = { segment_number: 1, start_hole: 1, end_hole: 18, format: 'singles', scoring_mode: 'gross', entry_mode: 'hole_outcomes', handicap_allowance: null, point_value: 1, players };
    const id = await rpc('save_match_plan_with_entry_modes', { match_payload: match, segment_payload: [segment] });
    const snapshot = async () => {
      const [matches, segments, matchPlayers, tournamentMatches, audit] = await Promise.all([
        read('matches', { id: eq(id), tournament_id: eq(tournamentId), select: '*' }),
        read('match_segments', { match_id: eq(id), select: '*' }),
        read('match_players', { match_id: eq(id), order: 'user_id', select: '*' }),
        read('matches', { tournament_id: eq(tournamentId), order: 'id', select: 'id' }),
        history([id]),
      ]);
      if (matches.length !== 1 || segments.length !== 1) throw new Error('Outcome fixture lost its unique match or segment');
      const [lineup, outcomes] = await Promise.all([
        read('match_segment_players', { segment_id: eq(segments[0].id), order: 'playing_order', select: '*' }),
        read('match_hole_outcomes', { segment_id: eq(segments[0].id), order: 'hole_number', select: '*' }),
      ]);
      return { match: matches[0], segment: segments[0], matchPlayers, tournamentMatches, lineup, outcomes, history: audit };
    };
    return { id, snapshot };
  }
  const holes = squadId => read('texas_scramble_hole_scores', { squad_id: eq(squadId), order: 'hole_number', select: '*' });
  async function archive() {
    const editions = await read('legacy_editions', { source_tournament_id: eq(tournamentId), select: '*' });
    if (editions.length !== 1) throw new Error('Expected one generated edition for the fixture tournament');
    const results = await read('legacy_results', { edition_id: eq(editions[0].id), order: 'source_segment_id,id', select: '*' });
    return { edition: editions[0], results };
  }
  return { tournamentId, sessionId, adminId, lineup, newOutcomeMatch, holes, history, archive };
}
