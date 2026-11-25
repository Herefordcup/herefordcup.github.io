import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/027_public_tournament_preview.sql', import.meta.url);
const appUrl = new URL('../src/app.js', import.meta.url);
const indexUrl = new URL('../index.html', import.meta.url);
const stylesUrl = new URL('../styles.css', import.meta.url);
const cachePaths = [
  '../src/admin.js', '../src/portal.js', '../src/past-trips.js',
  '../admin.html', '../portal.html', '../past-trips.html',
];

async function publicPreviewMigration() {
  return readFile(migrationUrl, 'utf8').catch(() => '');
}

test('public preview is exposed only through a hardened read-only RPC', async () => {
  const sql = await publicPreviewMigration();
  assert.match(sql, /create or replace function public\.get_public_tournament_preview\(\)/i);
  assert.match(sql, /returns jsonb[\s\S]*language sql[\s\S]*stable[\s\S]*security definer[\s\S]*set search_path = public/i);
  assert.match(sql, /revoke all on function public\.get_public_tournament_preview\(\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_public_tournament_preview\(\) to anon, authenticated/i);
  assert.doesNotMatch(sql, /grant select[\s\S]*to anon/i, 'source tables must not become directly readable by anonymous visitors');
  assert.doesNotMatch(sql, /create policy[\s\S]*to anon/i, 'existing member-only RLS must remain unchanged');
});

test('public preview filters matches to the Eastern tournament window and exposes no private scoring data', async () => {
  const sql = await publicPreviewMigration();
  assert.match(sql, /match_record\.starts_at at time zone 'America\/New_York'/i);
  assert.match(sql, /between selected_tournament\.starts_on and selected_tournament\.ends_on/i);
  assert.match(sql, /selected_tournament\.status in \('open', 'live'\)/i, 'setup match plans must remain private drafts');
  assert.match(sql, /event_record\.status <> 'cancelled'/i, 'cancelled itinerary entries must not appear active');
  assert.match(sql, /match_record\.status <> 'cancelled'/i, 'cancelled matches must not affect schedule or points');
  assert.match(sql, /segment\.status = 'final'/i, 'only finalized segments may contribute points');
  assert.match(sql, /sum\(segment\.point_value\)/i, 'the target must come from planned segment values');
  assert.match(sql, /bool_and\(segment\.point_value = 1\)/i, 'a numeric target is valid only for standard one-point segments');
  assert.match(sql, /point_summary\.planned_points \/ 2 \+ 0\.5/i);
  assert.match(sql, /\(current_timestamp at time zone 'America\/New_York'\)::date/i);
  for (const forbiddenKey of ['email', 'role', 'handicap', 'notes', 'createdAt', 'createdBy', 'updatedAt', 'approvedBy', 'rounds', 'scores']) {
    assert.doesNotMatch(sql, new RegExp(`'${forbiddenKey}'\\s*,`, 'i'), `private key leaked: ${forbiddenKey}`);
  }
  assert.doesNotMatch(sql, /\bjoin public\.(?:rounds|scores)\b/i);
});

test('public preview loader calls only the public RPC', async () => {
  const supabaseModule = await import('../src/supabase.js');
  assert.equal(typeof supabaseModule.loadPublicTournamentPreview, 'function');
  const calls = [];
  const payload = { tournament: { name: 'Hereford Cup 2027' }, events: [], matches: [] };
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: payload, error: null };
    },
  };

  assert.equal(await supabaseModule.loadPublicTournamentPreview(client), payload);
  assert.deepEqual(calls, [{ name: 'get_public_tournament_preview', args: undefined }]);
});

test('public schedule groups and sorts authoritative items by Eastern calendar day', async () => {
  const homeModule = await import('../src/home.js');
  assert.equal(typeof homeModule.groupPublicSchedule, 'function');
  const groups = homeModule.groupPublicSchedule({
    events: [
      { title: 'Late arrival', startsAt: '2027-03-19T03:30:00Z' },
      { title: 'Dinner', startsAt: '2027-03-19T23:00:00Z' },
    ],
    matches: [
      { name: 'Morning match', startsAt: '2027-03-19T12:00:00Z', segments: [{ segmentNumber: 1 }] },
      { name: 'Unpublished plan', startsAt: '2027-03-19T14:00:00Z', segments: [] },
    ],
  });

  assert.deepEqual(groups.map(group => group.date), ['2027-03-18', '2027-03-19']);
  assert.deepEqual(groups[0].items.map(item => `${item.kind}:${item.title}`), ['event:Late arrival']);
  assert.deepEqual(groups[1].items.map(item => `${item.kind}:${item.title}`), [
    'match:Morning match',
    'event:Dinner',
  ]);
});

test('both itinerary views can show Eastern tee-time windows, approximate times, and no time for TBD', async () => {
  const { formatItineraryTime } = await import('../src/home.js');
  assert.equal(formatItineraryTime('2027-03-19T12:00:00Z', '2027-03-19T12:32:00Z'), '8:00–8:32 AM');
  assert.equal(formatItineraryTime('2027-03-20T21:20:00Z', '2027-03-20T22:00:00Z', 'exact', true), 'Sat · 5:20–6:00 PM');
  assert.equal(formatItineraryTime('2027-03-21T17:30:00Z', null, 'approximate'), 'Around 1:30 PM');
  assert.equal(formatItineraryTime('2027-03-18T17:00:00Z', null, 'tbd', true), 'Thu · Time TBD');
  assert.equal(formatItineraryTime('2027-03-18T23:00:00Z'), '7:00 PM');
});

test('public pairing publication uses authoritative segment sides and keeps empty plans pending', async () => {
  const [sql, app] = await Promise.all([publicPreviewMigration(), readFile(appUrl, 'utf8')]);
  const homeModule = await import('../src/home.js');
  assert.match(sql, /'segments',[\s\S]*?'pairings',[\s\S]*?public\.match_segment_players/i);
  assert.doesNotMatch(sql, /'pairings',[\s\S]*?'segments',/i, 'pairings must not be flattened at match level');
  assert.match(sql, /'team',\s*pairing\.side/i);
  assert.doesNotMatch(sql, /from public\.match_players/i);
  assert.match(app, /segment\.pairings/);
  assert.doesNotMatch(app, /match\.pairings/);
  assert.match(app, /segment\.format/);
  assert.match(app, /formatName\(match\.status\)/);
  assert.equal(typeof homeModule.hasPublishedPublicPairings, 'function');
  assert.equal(homeModule.hasPublishedPublicPairings([{ segments: [{ segmentNumber: 1, pairings: [] }] }]), false);
  assert.equal(homeModule.hasPublishedPublicPairings([{ segments: [{ segmentNumber: 1, pairings: [{ team: 'blue', displayName: 'Player One' }] }] }]), true);
});

test('public point labels do not invent an unpublished target', async () => {
  const homeModule = await import('../src/home.js');
  assert.equal(typeof homeModule.formatPublicPoints, 'function');
  assert.equal(homeModule.formatPublicPoints(null), '—');
  assert.equal(homeModule.formatPublicPoints(6.5), '6½');
  assert.equal(homeModule.formatPublicPoints(6.25), '6.25');
});

test('homepage standings show only each team point total without a first-to target', async () => {
  const [app, html, css] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(indexUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  assert.doesNotMatch(html, /FIRST TO|id="targetPoints"|class="score-center"/i);
  assert.doesNotMatch(app, /targetPoints/);
  assert.match(css, /\.scoreboard\{[^}]*grid-template-columns:1fr 1fr/i);
});

test('homepage is a read-only RPC preview with explicit loading, empty, and unavailable states', async () => {
  const [app, html] = await Promise.all([readFile(appUrl, 'utf8'), readFile(indexUrl, 'utf8')]);
  for (const forbidden of ['localStorage', 'applyHoleResult', 'hole-controls', 'data-result=', 'undo']) {
    assert.doesNotMatch(`${app}\n${html}`, new RegExp(forbidden, 'i'), `editable scoreboard behavior remains: ${forbidden}`);
  }
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.write/i, 'database text must use safe DOM construction');
  assert.match(app, /loadPublicTournamentPreview/);
  assert.match(app, /groupPublicSchedule/);
  assert.match(app, /document\.createElement/);
  assert.match(app, /textContent/);
  assert.match(`${app}\n${html}`, /Loading official tournament preview/i);
  assert.match(app, /Tournament preview has not been published yet/i);
  assert.match(app, /Tournament preview is temporarily unavailable/i);
  assert.match(app, /function renderUnknownTotals\(/);
  assert.match(app, /function renderPreviewMessage[\s\S]*renderUnknownTotals\(\)/);
  assert.match(app, /Pairings will appear after they are published\./i);
  assert.doesNotMatch(html, />6½</, 'target must not be hard-coded');
  assert.doesNotMatch(html, /data-session="(?:fourball|foursomes|singles)"/i, 'day tabs must come from returned dates');
  assert.doesNotMatch(html, /Select the winner of each completed hole/i);
});

test('White shield is white with dark text and a visible border while Blue stays MIT blue', async () => {
  const css = await readFile(stylesUrl, 'utf8');
  assert.match(css, /\.team-cardinal \.team-code\{[^}]*background:var\(--team-blue\)/i);
  assert.match(css, /\.team-silver \.team-code\{[^}]*background:var\(--white\)[^}]*color:var\(--ink\)[^}]*border:[^;}]+/i);
  assert.doesNotMatch(css, /\.team-silver \.team-code\{[^}]*background:var\(--silver\)/i);
});

test('public itinerary and dynamic day tabs include narrow-screen overflow protection', async () => {
  const css = await readFile(stylesUrl, 'utf8');
  assert.match(css, /\.session-tabs\{[^}]*repeat\(auto-fit,minmax\(150px,1fr\)\)/i);
  assert.match(css, /\.itinerary-card\{[^}]*display:grid/i);
  assert.match(css, /\.pairing strong\{[^}]*overflow-wrap:anywhere/i);
  assert.match(css, /@media\(max-width:800px\)[\s\S]*\.session-tabs\{[^}]*repeat\(2,minmax\(0,1fr\)\)/i);
});

test('all entrypoints that reach changed shared modules are cache-busted together', async () => {
  const sources = await Promise.all(cachePaths.map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const [index, source] of sources.slice(0, 3).entries()) {
    assert.match(source, /supabase\.js\?v=organizer-scoring-2/, `missing shared data cache key in ${cachePaths[index]}`);
  }
  assert.match(sources[1], /home\.js\?v=itinerary-1/);
  for (const [offset, source] of sources.slice(3).entries()) {
    assert.match(source, /home-standings-1/, `missing public preview cache key in ${cachePaths[offset + 3]}`);
    assert.match(source, /styles\.css\?v=home-standings-1/, 'all shared stylesheet consumers must be cache-busted');
  }
});
