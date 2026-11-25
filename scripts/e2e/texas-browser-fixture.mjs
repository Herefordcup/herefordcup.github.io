import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertDisposableSupabaseUrl } from './safety.mjs';
import { organizerCheckData } from './organizer-check-data.mjs';

// Node-side setup and independent GET readback only. No hole is seeded.
export const cases = [
  { label: 'Blue A', side: 'cardinal', number: 1, scores: [3, ...Array(16).fill(4), 3], gross: 70, net: 67, points: 5 },
  { label: 'Blue B', side: 'cardinal', number: 2, scores: [5, ...Array(17).fill(4)], gross: 73, net: 70, points: 2 },
  { label: 'White A', side: 'silver', number: 1, scores: [3, 3, 3, ...Array(15).fill(4)], gross: 69, net: 66, points: 6 },
  { label: 'White B', side: 'silver', number: 2, scores: Array(18).fill(5), gross: 90, net: 87, points: 0 },
];

export async function seedScramble(env = process.env) {
  const url = assertDisposableSupabaseUrl(env.E2E_SUPABASE_URL);
  const { E2E_SERVICE_ROLE_KEY: service, E2E_SUPABASE_PUBLISHABLE_KEY: publicKey,
    E2E_USER_EMAIL: adminEmail, E2E_USER_PASSWORD: password } = env;
  if (!service || !publicKey || !adminEmail?.endsWith('@local.test') || !(password?.length >= 16)) {
    throw new Error('Missing disposable runner configuration');
  }
  const tag = randomUUID().slice(0, 8);
  async function call(path, { key = service, bearer = key, method = 'GET', body, prefer } = {}) {
    const headers = { apikey: key, Authorization: `Bearer ${bearer}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(18000),
    });
    const text = await response.text();
    if (!response.ok) {
      // Do not put auth response bodies, submitted credentials, or headers in reports.
      let detail = '';
      if (path.startsWith('/rest/v1/')) {
        try { const e = JSON.parse(text); detail = ` ${String(e.code ?? '')}: ${String(e.message ?? '').slice(0, 180)}`; } catch { /* non-JSON error */ }
      }
      throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}${detail}`);
    }
    return text ? JSON.parse(text) : null;
  }
  const insert = (table, body) => call(`/rest/v1/${table}`, { method: 'POST', body, prefer: 'return=representation' });
  const admin = await call('/auth/v1/token?grant_type=password', {
    key: publicKey, method: 'POST', body: { email: adminEmail, password },
  });
  assert.ok(admin.user?.id && admin.access_token, 'Disposable planner must be signed in');
  const rpc = (name, body) => call(`/rest/v1/rpc/${name}`, { key: publicKey, bearer: admin.access_token, method: 'POST', body });
  async function createTournament(year, status) {
    const [tournament] = await insert('tournaments', {
      name: `Disposable Scramble ${year} ${tag}`, slug: `disposable-scramble-${year}-${tag}`, edition_year: year,
      status, starts_on: `${year}-03-18`, ends_on: `${year}-03-21`, created_by: admin.user.id,
    });
    return tournament;
  }
  const scoringTournament = await createTournament(2027, 'live');
  const [course] = await insert('courses', { name: `Disposable Scramble Links ${tag}`, location: 'Loopback', active: true, created_by: admin.user.id });
  const [tee] = await insert('tees', { course_id: course.id, name: 'Scramble QA', rating_category: 'M', rating: 72, slope: 113, rating_par: 72, par: 72, yardage: 6300 });
  await insert('holes', Array.from({ length: 18 }, (_, i) => ({ tee_id: tee.id, hole_number: i + 1, par: 4, stroke_index: i + 1, yardage: 350 })));
  const roster = [];
  for (const item of cases) {
    const players = [];
    for (const [index, handicap] of [8, 0, 12, 4].entries()) {
      const name = `${item.label} Player ${index + 1}`;
      const email = `scramble-${tag}-${roster.length}-${index}@local.test`;
      const user = await call('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true, user_metadata: { display_name: name } } });
      const [profile] = await call(`/rest/v1/profiles?id=eq.${user.id}`, { method: 'PATCH', body: { display_name: name, handicap_index: handicap, role: 'player' }, prefer: 'return=representation' });
      assert.equal(profile.role, 'player');
      players.push({ id: user.id, name, email });
    }
    roster.push({ ...item, players });
  }
  async function seedPlan(tournament) {
    const memberships = roster.flatMap(s => s.players.map(p => ({
      tournament_id: tournament.id, user_id: p.id, status: 'active', role: 'player', team: s.side, joined_at: new Date().toISOString(),
    })));
    const members = await call('/rest/v1/tournament_memberships?on_conflict=tournament_id,user_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: memberships,
    });
    assert.equal(members.length, 16);
    for (const { user_id, team } of memberships) {
      assert.ok(members.some(m => m.tournament_id === tournament.id && m.user_id === user_id && m.team === team && m.status === 'active' && m.role === 'player'));
    }
    const sessionId = await rpc('save_texas_scramble_plan', {
      session_payload: { tournament_id: tournament.id, name: 'Texas Scramble', session_label: 'Browser QA', starts_at: `${tournament.edition_year}-03-19T13:00:00Z`, start_hole: 1, end_hole: 18, required_tee_shots: 3 },
      squad_payload: roster.map(s => ({ label: s.label, side: s.side, squad_number: s.number, player_ids: s.players.map(p => p.id) })),
    });
    const readSquads = () => call(`/rest/v1/texas_scramble_squads?session_id=eq.${sessionId}&select=id,match_id,segment_id,label,side,status,gross_total,net_score,playing_handicap,par_total,points&order=id`);
    const saved = await readSquads();
    assert.equal(saved.length, 4);
    const squads = roster.map(s => {
      const row = saved.find(r => r.label === s.label && r.side === s.side);
      assert.ok(row && row.status === 'scheduled');
      return { ...s, players: [...s.players], id: row.id, matchId: row.match_id, segmentId: row.segment_id };
    });
    const squadIds = squads.map(s => s.id).join(',');
    const matchIds = squads.map(s => s.matchId).join(',');
    const playerIds = memberships.map(m => m.user_id).join(',');
    const readHoles = () => call(`/rest/v1/texas_scramble_hole_scores?squad_id=in.(${squadIds})&select=squad_id,hole_number,gross_score,tee_shot_player_id,submitted_by&order=squad_id,hole_number`);
    const readSession = async () => (await call(`/rest/v1/texas_scramble_sessions?id=eq.${sessionId}&select=status,course_id,tee_id`))[0];
    const readSegments = () => call(`/rest/v1/match_segments?match_id=in.(${matchIds})&select=id,status,holes_played,point_value,differential&order=id`);
    const readRounds = () => call(`/rest/v1/rounds?or=(match_id.in.(${matchIds}),user_id.in.(${playerIds}))&select=id`);
    assert.deepEqual(await readHoles(), []);
    assert.deepEqual(await readSession(), { status: 'scheduled', course_id: null, tee_id: null });
    const organizer = organizerCheckData({ call, rpc, tournamentId: tournament.id, sessionId, courseId: course.id, squads, adminId: admin.user.id });
    return { squads, courseId: course.id, teeId: tee.id, readSquads, readHoles, readSession, readSegments, readRounds, organizer };
  }
  return {
    scoring: await seedPlan(scoringTournament),
    createLineupFixture: async () => seedPlan(await createTournament(2098, 'setup')),
  };
}
