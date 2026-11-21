import { writeFile } from 'node:fs/promises';
import { assertDisposableSupabaseUrl } from './safety.mjs';

const apiUrl = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
const serviceRoleKey = process.env.E2E_SERVICE_ROLE_KEY;
const password = process.env.E2E_USER_PASSWORD;
const fixtureFile = process.env.E2E_FIXTURE_FILE;

if (!serviceRoleKey) throw new Error('Missing local E2E service-role key.');
if (!password || password.length < 16) throw new Error('E2E password must be generated at runtime.');
if (!fixtureFile) throw new Error('Missing runner-temporary fixture path.');

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function insert(table, body) {
  const rows = await request(`/rest/v1/${table}`, {
    method: 'POST',
    body,
    prefer: 'return=representation',
  });
  return Array.isArray(body) ? rows : rows[0];
}

async function upsertMemberships(body) {
  return request('/rest/v1/tournament_memberships?on_conflict=tournament_id,user_id', {
    method: 'POST',
    body,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

const adminDefinitions = [
  { email: 'qa-admin-1@local.test', name: 'QA Admin One', team: 'cardinal', handicap: 0, globalRole: 'admin' },
  { email: 'qa-admin-2@local.test', name: 'QA Admin Two', team: 'cardinal', handicap: 0, globalRole: 'player' },
  { email: 'qa-admin-3@local.test', name: 'QA Admin Three', team: 'silver', handicap: 0, globalRole: 'player' },
  { email: 'qa-admin-4@local.test', name: 'QA Admin Four', team: 'silver', handicap: 0, globalRole: 'player' },
];

const admins = [];
for (const definition of adminDefinitions) {
  const user = await request('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email: definition.email,
      password,
      email_confirm: true,
      user_metadata: { display_name: definition.name, full_name: definition.name },
    },
  });
  await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH',
    body: {
      display_name: definition.name,
      handicap_index: definition.handicap,
      role: definition.globalRole,
    },
    prefer: 'return=representation',
  });
  admins.push({ ...definition, id: user.id });
}

const mainTournament = await insert('tournaments', {
  name: '[DISPOSABLE-QA] Four-admin matrix',
  slug: 'disposable-four-admin-qa',
  edition_year: 2027,
  starts_on: '2027-03-18',
  ends_on: '2027-03-21',
  status: 'live',
  created_by: admins[0].id,
});
const rejectionTournament = await insert('tournaments', {
  name: '[DISPOSABLE-QA] Rejection matrix',
  slug: 'disposable-four-admin-rejections',
  edition_year: 2098,
  starts_on: '2098-03-18',
  ends_on: '2098-03-21',
  status: 'open',
  created_by: admins[0].id,
});
const roleProtectionTournament = await insert('tournaments', {
  name: '[DISPOSABLE-QA] Last-admin protection',
  slug: 'disposable-last-admin-protection',
  edition_year: 2097,
  starts_on: '2097-03-18',
  ends_on: '2097-03-21',
  status: 'setup',
  created_by: admins[0].id,
});

await upsertMemberships(admins.map(admin => ({
  tournament_id: mainTournament.id,
  user_id: admin.id,
  status: 'active',
  role: 'admin',
  team: admin.team,
  joined_at: new Date().toISOString(),
})));
await upsertMemberships(admins.map((admin, index) => ({
  tournament_id: rejectionTournament.id,
  user_id: admin.id,
  status: 'active',
  role: 'admin',
  team: index === 3 ? null : admin.team,
  joined_at: new Date().toISOString(),
})));
await upsertMemberships(admins.map((admin, index) => ({
  tournament_id: roleProtectionTournament.id,
  user_id: admin.id,
  status: 'active',
  role: index === 1 ? 'admin' : 'player',
  team: admin.team,
  joined_at: new Date().toISOString(),
})));

const course = await insert('courses', {
  name: '[DISPOSABLE-QA] Deterministic Golf Club',
  location: 'Loopback, Local',
  active: true,
  created_by: admins[0].id,
});
const commonTee = await insert('tees', {
  course_id: course.id,
  name: 'Matrix Common',
  rating: 72,
  slope: 113,
  par: 72,
  yardage: 6300,
});
const alternateTee = await insert('tees', {
  course_id: course.id,
  name: 'Matrix Mismatch',
  rating: 72,
  slope: 113,
  par: 72,
  yardage: 6300,
});
const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
await insert('holes', pars.map((par, index) => ({
  tee_id: commonTee.id,
  hole_number: index + 1,
  par,
  stroke_index: index + 1,
  yardage: par === 3 ? 165 : par === 5 ? 500 : 385,
})));
await insert('holes', pars.map((par, index) => ({
  tee_id: alternateTee.id,
  hole_number: index + 1,
  par,
  stroke_index: index === 17 ? 1 : index + 2,
  yardage: par === 3 ? 165 : par === 5 ? 500 : 385,
})));

const baseScores = () => Array.from({ length: 18 }, () => 5);
const withWins = (holes, winningScore = 4) => {
  const scores = baseScores();
  for (const hole of holes) scores[hole - 1] = winningScore;
  return scores;
};

async function createFixture({
  tournamentId,
  code,
  name,
  startsAt,
  segments,
  scoreSets = new Map(),
  incomplete = new Map(),
  teeByUser = new Map(),
}) {
  const match = await insert('matches', {
    tournament_id: tournamentId,
    name: `[DISPOSABLE-QA][${code}] ${name}`,
    session: `[DISPOSABLE-QA][${code}] scenario`,
    format: segments[0].format,
    scoring_mode: segments[0].scoringMode,
    starts_at: startsAt,
    course_id: course.id,
    status: 'scheduled',
  });

  const segmentRows = [];
  for (const [index, segment] of segments.entries()) {
    const savedSegment = await insert('match_segments', {
      match_id: match.id,
      segment_number: index + 1,
      start_hole: segment.startHole,
      end_hole: segment.endHole,
      format: segment.format,
      scoring_mode: segment.scoringMode,
      handicap_allowance: segment.scoringMode === 'net' ? (segment.handicapAllowance ?? 100) : null,
      point_value: segment.pointValue ?? 1,
      status: 'scheduled',
      differential: 0,
      holes_played: 0,
    });
    await insert('match_segment_players', segment.players.map((player, playingIndex) => ({
      segment_id: savedSegment.id,
      user_id: admins[player].id,
      team: admins[player].team,
      side: admins[player].team,
      playing_order: playingIndex + 1,
    })));
    segmentRows.push(savedSegment);
  }

  const playerIndexes = [...new Set(segments.flatMap(segment => segment.players))];
  await insert('match_players', playerIndexes.map(player => ({
    match_id: match.id,
    user_id: admins[player].id,
    team: admins[player].team,
  })));

  const rounds = {};
  for (const player of playerIndexes) {
    const round = await insert('rounds', {
      user_id: admins[player].id,
      match_id: match.id,
      course_id: course.id,
      tee_id: teeByUser.get(player) ?? commonTee.id,
      course_handicap: 0,
    });
    rounds[player] = round;
    const scores = scoreSets.get(player) ?? baseScores();
    const holeLimit = incomplete.get(player) ?? 18;
    await insert('scores', scores.slice(0, holeLimit).map((grossScore, index) => ({
      round_id: round.id,
      user_id: admins[player].id,
      hole_number: index + 1,
      gross_score: grossScore,
    })));
  }

  return { match, segments: segmentRows, rounds };
}

const fixtures = {};
fixtures.S1 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'S1',
  name: 'Singles gross Blue 1 Up',
  startsAt: '2027-03-18T13:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'gross', players: [0, 2] }],
  scoreSets: new Map([[0, withWins([1])], [2, baseScores()]]),
});
fixtures.S2 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'S2',
  name: 'Singles net White 2 & 1',
  startsAt: '2027-03-18T14:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'net', players: [1, 3] }],
  scoreSets: new Map([[1, baseScores()], [3, withWins([1, 2])]]),
});
fixtures.F1 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'F1',
  name: 'Four-Ball gross halve',
  startsAt: '2027-03-19T13:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'fourball', scoringMode: 'gross', players: [0, 1, 2, 3] }],
});
fixtures.F2 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'F2',
  name: 'Four-Ball net Blue 3 & 2',
  startsAt: '2027-03-19T14:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'fourball', scoringMode: 'net', players: [0, 1, 2, 3] }],
  scoreSets: new Map([[0, withWins([1, 2, 3])], [1, baseScores()], [2, baseScores()], [3, baseScores()]]),
});
fixtures.M1 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'M1',
  name: 'Mixed Four-Ball and Foursomes',
  startsAt: '2027-03-20T13:00:00Z',
  segments: [
    { startHole: 1, endHole: 9, format: 'fourball', scoringMode: 'gross', pointValue: 0.5, players: [0, 1, 2, 3] },
    { startHole: 10, endHole: 18, format: 'foursomes', scoringMode: 'net', handicapAllowance: 50, pointValue: 0.5, players: [0, 1, 2, 3] },
  ],
  scoreSets: new Map([[0, withWins([1])], [1, baseScores()], [2, baseScores()], [3, baseScores()]]),
});
fixtures.C1 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'C1',
  name: 'Audited correction changes result',
  startsAt: '2027-03-20T14:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'gross', players: [0, 2] }],
});
fixtures.X1 = await createFixture({
  tournamentId: mainTournament.id,
  code: 'X1',
  name: 'Concurrent finalization',
  startsAt: '2027-03-21T13:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'gross', players: [1, 3] }],
});
fixtures.R1 = await createFixture({
  tournamentId: rejectionTournament.id,
  code: 'R1',
  name: 'Incomplete score rejection',
  startsAt: '2098-03-18T13:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'gross', players: [0, 2] }],
  incomplete: new Map([[2, 17]]),
});
fixtures.R2 = await createFixture({
  tournamentId: rejectionTournament.id,
  code: 'R2',
  name: 'Mismatched stroke-index rejection',
  startsAt: '2098-03-18T14:00:00Z',
  segments: [{ startHole: 1, endHole: 18, format: 'singles', scoringMode: 'net', players: [1, 2] }],
  teeByUser: new Map([[2, alternateTee.id]]),
});

const plannedEdition = await insert('legacy_editions', {
  edition_year: 2100,
  venue: '[DISPOSABLE-QA] Deterministic Golf Club',
  destination: 'Loopback, Local',
  status: 'planned',
  published: false,
});

const manifest = {
  admins: admins.map(({ id, email, name, team }) => ({ id, email, name, team })),
  tournaments: {
    main: mainTournament.id,
    rejection: rejectionTournament.id,
    roleProtection: roleProtectionTournament.id,
  },
  course: { id: course.id, commonTee: commonTee.id, alternateTee: alternateTee.id },
  plannedEdition: plannedEdition.id,
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([code, fixture]) => [code, {
    match: fixture.match.id,
    segments: fixture.segments.map(segment => segment.id),
    rounds: Object.fromEntries(Object.entries(fixture.rounds).map(([player, round]) => [player, round.id])),
  }])),
};
await writeFile(fixtureFile, JSON.stringify(manifest), { mode: 0o600 });

// Matrix coverage markers: [S1] [S2] [F1] [F2] [M1] [R1] [R2] [R3]
// [C1] [A1] [A2] [X1] [X2] [T1] [T2] [T3] [T4] [T5]
console.log('Seeded the disposable four-administrator QA matrix.');
