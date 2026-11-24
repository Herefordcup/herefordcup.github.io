import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLegacyEditionPayload, buildLegacyResultPayload } from '../src/supabase.js';

const root = new URL('../', import.meta.url);
const indexHtml = await readFile(new URL('index.html', root), 'utf8');
const portalHtml = await readFile(new URL('portal.html', root), 'utf8');
const pastTripsHtml = await readFile(new URL('past-trips.html', root), 'utf8');
const pastTripsScript = await readFile(new URL('src/past-trips.js', root), 'utf8');
const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const appScript = await readFile(new URL('src/app.js', root), 'utf8');
const adminScript = await readFile(new URL('src/admin.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');
const migrationUrl = new URL('supabase/migrations/009_legacy_archive.sql', root);
const hardeningMigrationUrl = new URL('supabase/migrations/012_commentary_and_legacy_hardening.sql', root);

test('public home shows a champions-only Legacy summary', () => {
  assert.doesNotMatch(indexHtml, /EST\. 2026/);
  assert.match(indexHtml, /EST\. 2023/);
  assert.match(indexHtml, /id="legacyWinners"/);
  assert.doesNotMatch(indexHtml, /id="legacyTimeline"|id="legacyDetails"|id="legacyGallery"/);
  assert.match(appScript, /renderLegacyWinners/);
  assert.doesNotMatch(appScript, /renderLegacyArchive/);
});

test('More links to a full Past Trips page with stories, results, and moments', () => {
  assert.match(portalHtml, /href="past-trips\.html"/);
  assert.match(portalHtml, />Past Trips</);
  for (const id of ['legacyTimeline', 'legacyDetails', 'legacyGallery']) {
    assert.match(pastTripsHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(pastTripsHtml, /MOMENTS CAPTURED/i);
  assert.match(pastTripsScript, /loadLegacyArchive/);
  assert.match(pastTripsScript, /renderLegacyArchive/);
});

test('uploaded Past Trips photos open in an accessible full-view dialog', () => {
  for (const id of ['legacyPhotoDialog', 'legacyPhotoFull', 'legacyPhotoCaption', 'legacyPhotoClose']) {
    assert.match(pastTripsHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(legacyScript, /legacy-photo-open/);
  assert.match(legacyScript, /View .* full size/);
  assert.match(pastTripsScript, /showModal\(\)/);
  assert.match(pastTripsScript, /legacyPhotoDialog\.close\(\)/);
  assert.match(pastTripsHtml, /href="past-trips\.css\?v=legacy-scorecards-4"/);
  assert.match(pastTripsHtml, /src="src\/past-trips\.js\?v=texas-scramble-1"/);
  assert.match(pastTripsScript, /from '\.\/legacy\.js\?v=pimentel-correction-1'/);
});

test('legacy schema is publicly readable, admin-write-only, and seeds the known trips without fabricated winners', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['legacy_editions', 'legacy_results', 'legacy_photos']) {
    assert.match(sql, new RegExp(`create table[^;]*public\\.${table}`, 'is'), `missing ${table}`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /grant select on public\.legacy_editions, public\.legacy_results, public\.legacy_photos to anon/i);
  assert.match(sql, /public\.is_admin\(\)/i);
  assert.match(sql, /legacy-photos/i);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /before insert or update on public\.legacy_editions/i);
  assert.match(sql, /file_size_limit[\s\S]{0,120}8388608/i);
  for (const trip of [
    ['2023', 'Barefoot', 'Myrtle Beach'],
    ['2024', 'Innisbrook', 'Tampa'],
    ['2025', 'PGA Frisco', 'Texas'],
    ['2026', 'Kiawah', 'South Carolina'],
    ['2027', 'Pinehurst', 'North Carolina'],
  ]) {
    for (const value of trip) assert.match(sql, new RegExp(value, 'i'));
  }
  assert.doesNotMatch(sql, /winner_name[^;]*values[^;]*['"][^'"]+['"]/is);
});

test('administrators can manage editions, result rows, and photo uploads', () => {
  for (const id of ['legacyEditionForm', 'legacyEditionSelect', 'legacyResultForm', 'legacyPhotoForm', 'legacyPhotoFile']) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const fn of ['saveLegacyEdition', 'saveLegacyResult', 'uploadLegacyPhoto', 'deleteLegacyPhoto']) {
    assert.match(supabaseScript, new RegExp(`export async function ${fn}`), `missing ${fn}`);
    assert.match(adminScript, new RegExp(fn), `admin does not use ${fn}`);
  }
  assert.match(supabaseScript, /\.storage\.from\('legacy-photos'\)/);
  assert.match(supabaseScript, /image\/(jpeg|png|webp)/);
  assert.doesNotMatch(supabaseScript, /export async function (?:saveLegacyEdition|saveLegacyResult|uploadLegacyPhoto)\([^)]*userId/);
});

test('legacy rendering uses text nodes for administrator-authored content', async () => {
  const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
  assert.doesNotMatch(legacyScript, /innerHTML/);
  assert.match(legacyScript, /textContent/);
  assert.match(legacyScript, /replaceChildren/);
});

test('Legacy photos are private, publication-aware, and use signed URLs', async () => {
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /update storage\.buckets[\s\S]*set public = false[\s\S]*legacy-photos/i);
  assert.match(sql, /published legacy photos are readable/i);
  assert.match(sql, /edition\.published/i);
  assert.match(supabaseScript, /createSignedUrl\(photo\.storage_path/);
  assert.doesNotMatch(supabaseScript, /object\/public\/legacy-photos/);
});

test('Legacy photo deletion removes metadata before attempting storage cleanup', async () => {
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /function public\.delete_legacy_photo\(target_photo_id uuid\)/i);
  assert.match(sql, /if not public\.is_admin\(\)/i);
  assert.match(supabaseScript, /rpc\('delete_legacy_photo'/);
  const rpcPosition = supabaseScript.indexOf("rpc('delete_legacy_photo'");
  const removePosition = supabaseScript.indexOf("storage.from('legacy-photos').remove", rpcPosition);
  assert.ok(rpcPosition >= 0 && removePosition > rpcPosition);
});

test('Legacy publication state is authoritative and tab controls are keyboard accessible', async () => {
  const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /alter column published set default false/i);
  assert.doesNotMatch(adminHtml, /name="published" type="checkbox" checked/);
  assert.doesNotMatch(appScript, /editions: knownLegacyTrips/);
  assert.doesNotMatch(legacyScript, /editions\?\.length \? editions : knownLegacyTrips/);
  assert.match(legacyScript, /aria-controls/);
  assert.match(legacyScript, /ArrowLeft|ArrowRight/);
  assert.match(legacyScript, /tabIndex/);
});

test('administrators can update and remove Legacy result rows', () => {
  for (const fn of ['saveLegacyResult', 'deleteLegacyResult']) {
    assert.match(supabaseScript, new RegExp(`export async function ${fn}`));
    assert.match(adminScript, new RegExp(fn));
  }
  assert.match(adminHtml, /id="legacyResultList"/);
  assert.match(adminScript, /renderLegacyResultList/);
});

test('Legacy admin exposes structured edition and result ledger controls', () => {
  for (const name of ['expectedPoints', 'cardinalTotal', 'silverTotal', 'scoreConfidence', 'sourceNotes']) {
    assert.match(adminHtml, new RegExp(`name=["']${name}["']`), `missing edition field ${name}`);
  }
  for (const name of ['eventGroup', 'formatLabel', 'handicapAllowance', 'pointsAvailable', 'cardinalPoints', 'silverPoints', 'confidence', 'sourceNote']) {
    assert.match(adminHtml, new RegExp(`name=["']${name}["']`), `missing result field ${name}`);
  }
  assert.match(adminHtml, /<div id="legacyReconciliation" aria-live="polite"><\/div>/);
  for (const confidence of ['confirmed', 'probable', 'unresolved']) {
    assert.match(adminHtml, new RegExp(`value=["']${confidence}["']`, 'i'));
  }
});

test('Legacy saves every structured field explicitly without coercing blanks to zero', () => {
  for (const column of ['expected_points', 'cardinal_total', 'silver_total', 'source_notes']) {
    assert.match(supabaseScript, new RegExp(`["']${column}["']`), `missing edition payload ${column}`);
  }
  assert.match(supabaseScript, /payload\.score_confidence/);
  for (const column of ['event_group', 'format_label', 'handicap_allowance', 'points_available', 'cardinal_points', 'silver_points', 'source_note']) {
    assert.match(supabaseScript, new RegExp(`["']${column}["']`), `missing result payload ${column}`);
  }
  assert.match(supabaseScript, /payload\.confidence/);
  assert.match(adminScript, /optionalNumber\(data\.get\('expectedPoints'\)\)/);
  assert.match(adminScript, /optionalNumber\(data\.get\('cardinalPoints'\)\)/);
  assert.doesNotMatch(supabaseScript, /(?:expected_points|cardinal_total|silver_total|points_available|cardinal_points|silver_points): Number\([^)]*\|\| 0\)/);
});

test('Legacy save payloads preserve structured columns for callers using the previous signatures', () => {
  const editionPayload = buildLegacyEditionPayload({
    year: 2024,
    venue: 'Innisbrook',
    destination: 'Tampa',
    status: 'completed',
    winnerName: 'Blue',
    runnerUpName: 'White',
    finalScore: '23.5–19.5',
    story: 'Original story',
    published: true,
  });
  for (const column of ['expected_points', 'cardinal_total', 'silver_total', 'score_confidence', 'source_notes']) {
    assert.equal(Object.hasOwn(editionPayload, column), false, `${column} must remain untouched when omitted`);
  }

  const resultPayload = buildLegacyResultPayload({
    editionId: 'edition-id',
    label: 'Match 1',
    cardinalEntry: 'Blue entry',
    silverEntry: 'White entry',
    result: 'Original result',
    sortOrder: 10,
  });
  for (const column of ['event_group', 'format_label', 'handicap_allowance', 'points_available', 'cardinal_points', 'silver_points', 'confidence', 'source_note']) {
    assert.equal(Object.hasOwn(resultPayload, column), false, `${column} must remain untouched when omitted`);
  }

  assert.equal(buildLegacyEditionPayload({
    year: 2025,
    venue: 'PGA Frisco',
    destination: 'Frisco',
    status: 'completed',
    published: false,
    expectedPoints: null,
    cardinalTotal: null,
    silverTotal: null,
    scoreConfidence: 'unresolved',
    sourceNotes: '',
  }).expected_points, null);
});

test('Legacy admin renders final-score reconciliation and blocks an invalid confirmed publication', () => {
  assert.match(adminScript, /summarizeLegacyLedger/);
  assert.match(adminScript, /function renderLegacyReconciliation/);
  for (const label of ['Expected', 'Blue', 'White', 'Recorded row awards', 'Unresolved', 'Overallocated', 'Final score reconciled']) {
    assert.match(adminScript, new RegExp(label, 'i'));
  }
  assert.match(adminScript, /scoreConfidence === 'confirmed'[\s\S]*published[\s\S]*!summary\.reconciled/);
});

test('Legacy admin cache-busts each changed browser dependency', () => {
  assert.match(adminHtml, /href="admin\.css\?v=texas-scramble-1"/);
  assert.match(adminHtml, /src="src\/admin\.js\?v=texas-scramble-1"/);
  assert.match(adminScript, /from '\.\/supabase\.js\?v=texas-scramble-1'/);
  assert.match(adminScript, /from '\.\/legacy-ledger\.js\?v=legacy-ledger-2'/);
});

test('Past Trips renders every trip with the same simple matchup and points format', () => {
  assert.match(legacyScript, /groupLegacyResults/);
  assert.match(legacyScript, /public_visible !== false/);
  assert.match(legacyScript, /event_group\?\.trim\(\) !== 'Reconciliation'/);
  assert.match(legacyScript, /node\('details', 'legacy-result-group'\)/);
  assert.match(legacyScript, /node\('summary'/);
  assert.match(legacyScript, /\.open = true/);
  assert.match(legacyScript, /format_label/);
  assert.match(legacyScript, /cardinal_entry/);
  assert.match(legacyScript, /silver_entry/);
  assert.match(legacyScript, /Blue .* White/);
  for (const hiddenLabel of ['Confirmed', 'Probable', 'Source incomplete', 'Expected', 'Point gap', 'Scoring rows', 'Final score reconciled']) {
    assert.doesNotMatch(legacyScript, new RegExp(`['"\\x60]${hiddenLabel}`));
  }
  assert.doesNotMatch(legacyScript, /confidenceLabel|source_notes|source_note|summarizeLegacyLedger/);
  assert.doesNotMatch(legacyScript, /selected\.story|result\.result/);
  assert.match(legacyScript, /legacyResultText\(result, selected\.edition_year\)/);
  assert.match(legacyScript, /legacy-scorecard-empty/);
  assert.match(legacyScript, /Results not recorded/);
  assert.match(legacyScript, /Blue — - White —/);
  assert.doesNotMatch(legacyScript, /innerHTML/);
});

test('Past Trips cache-busts every changed scorecard dependency', async () => {
  assert.match(pastTripsHtml, /href="past-trips\.css\?v=legacy-scorecards-4"/);
  assert.match(pastTripsHtml, /src="src\/past-trips\.js\?v=texas-scramble-1"/);
  assert.match(pastTripsScript, /from '\.\/supabase\.js\?v=texas-scramble-1'/);
  assert.match(pastTripsScript, /from '\.\/legacy\.js\?v=pimentel-correction-1'/);
  assert.match(indexHtml, /src="src\/app\.js\?v=texas-scramble-1"/);
  assert.match(appScript, /from '\.\/supabase\.js\?v=texas-scramble-1'/);
  assert.match(appScript, /from '\.\/legacy\.js\?v=pimentel-correction-1'/);
  assert.match(portalHtml, /src="src\/portal\.js\?v=texas-scramble-1"/);
  const portalScript = await readFile(new URL('src/portal.js', root), 'utf8');
  assert.match(portalScript, /from '\.\/supabase\.js\?v=texas-scramble-1'/);
  assert.match(portalScript, /from '\.\/member\.js\?v=member-role-1'/);
});
