import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ledgerModule = await import('../src/legacy-ledger.js').catch(() => ({}));
const { summarizeLegacyLedger } = ledgerModule;
const legacyModule = await import('../src/legacy.js').catch(() => ({}));
const { groupLegacyResults } = legacyModule;
const root = new URL('../', import.meta.url);
const migrationUrl = new URL('supabase/migrations/025_legacy_scoring_ledger.sql', root);
const migrationSql = await readFile(migrationUrl, 'utf8').catch(() => '');

function requiresColumn(table, column, definition) {
  assert.match(
    migrationSql,
    new RegExp(`alter table public\\.${table}[\\s\\S]*add column if not exists ${column} ${definition}`, 'i'),
    `missing ${table}.${column}`,
  );
}

test('migration 025 adds the structured Legacy ledger without replacing existing tables', () => {
  for (const [column, definition] of [
    ['expected_points', 'numeric\\(7,2\\)'],
    ['cardinal_total', 'numeric\\(7,2\\)'],
    ['silver_total', 'numeric\\(7,2\\)'],
    ['score_confidence', "text not null default 'unresolved'"],
    ['source_notes', 'text'],
  ]) requiresColumn('legacy_editions', column, definition);

  for (const [column, definition] of [
    ['event_group', 'text'],
    ['format_label', 'text'],
    ['handicap_allowance', 'text'],
    ['points_available', 'numeric\\(7,2\\)'],
    ['cardinal_points', 'numeric\\(7,2\\)'],
    ['silver_points', 'numeric\\(7,2\\)'],
    ['confidence', "text not null default 'unresolved'"],
    ['source_note', 'text'],
  ]) requiresColumn('legacy_results', column, definition);

  assert.doesNotMatch(migrationSql, /create table[^;]*legacy_(?:editions|results)/i);
});

test('migration 025 constrains confidence, nonnegative points, allocations, and edition totals', () => {
  assert.match(migrationSql, /score_confidence in \('confirmed', 'probable', 'unresolved'\)/i);
  assert.match(migrationSql, /confidence in \('confirmed', 'probable', 'unresolved'\)/i);
  for (const column of ['expected_points', 'cardinal_total', 'silver_total', 'points_available', 'cardinal_points', 'silver_points']) {
    assert.match(migrationSql, new RegExp(`${column} is null or ${column} >= 0`, 'i'), `missing nonnegative check for ${column}`);
  }
  assert.match(migrationSql, /cardinal_points \+ silver_points <= points_available/i);
  assert.match(migrationSql, /cardinal_total \+ silver_total <= expected_points/i);
  assert.match(migrationSql, /cardinal_points is null or points_available is null or cardinal_points <= points_available/i);
  assert.match(migrationSql, /silver_points is null or points_available is null or silver_points <= points_available/i);
  assert.match(migrationSql, /cardinal_total is null or expected_points is null or cardinal_total <= expected_points/i);
  assert.match(migrationSql, /silver_total is null or expected_points is null or silver_total <= expected_points/i);
  assert.match(migrationSql, /published is not true[\s\S]*score_confidence <> 'confirmed'[\s\S]*cardinal_total \+ silver_total = expected_points/i);
  assert.match(migrationSql, /legacy_results_edition_group_order_idx/i);
});

test('migration 025 preserves existing RLS and write boundaries', () => {
  assert.doesNotMatch(migrationSql, /create policy|grant (?:insert|update|delete|all)[^;]* to anon/i);
  assert.doesNotMatch(migrationSql, /disable row level security/i);
});

test('migration 025 backfills the declared 2024 and 2025 edition totals', () => {
  assert.match(migrationSql, /\(2024,\s*43(?:\.0+)?,\s*23\.5(?:0)?,\s*19\.5(?:0)?,\s*'confirmed'/i);
  assert.match(migrationSql, /\(2025,\s*52(?:\.0+)?,\s*23\.5(?:0)?,\s*21\.5(?:0)?,\s*'unresolved'/i);
  assert.match(migrationSql, /edition\.edition_year = backfill\.edition_year/i);
});

test('migration 025 assigns every known result to a stable event group', () => {
  for (const group of [
    'Match 1 — Texas Scramble',
    'Match 2 — Scramble',
    'Putt-Putt',
    'Match 3 — Best Ball',
    'Match 4 — Shamble',
    'Long Drive',
    'Par 3 — Shamble',
    'Match 5 — Singles — Front 9',
    'Match 5 — Singles — Back 9',
    'Reconciliation',
  ]) assert.match(migrationSql, new RegExp(group, 'u'), `missing event group ${group}`);

  assert.match(migrationSql, /Match 2 · Scramble 2v2 · Pairing 2[\s\S]*?2(?:\.0+)?,\s*null,\s*null,\s*'unresolved'/i);
  assert.match(migrationSql, /Match 3 · Best Ball 2v2 · Pairing 2[\s\S]*?2(?:\.0+)?,\s*null,\s*1(?:\.0+)?,\s*'unresolved'/i);
  assert.match(migrationSql, /Long Drive · PH\?[\s\S]*?0\.5(?:0)?,\s*0\.5(?:0)?,\s*0(?:\.0+)?,\s*'probable'/i);
  assert.match(migrationSql, /Source sheet working total[\s\S]*?'Reconciliation'/i);
});

test('migration 025 keeps uncertain rows uncertain and asserts complete 2024/2025 coverage', () => {
  assert.match(migrationSql, /Pretty sure Blue won both[\s\S]*?'probable'/i);
  assert.match(migrationSql, /Pretty sure White won both[\s\S]*?'probable'/i);
  assert.match(migrationSql, /Source sheet checkpoint before Singles[\s\S]*?'unresolved'/i);
  assert.match(migrationSql, /raise exception[^;]*Legacy scoring backfill is incomplete/i);
  assert.match(migrationSql, /edition_year in \(2024, 2025\)[\s\S]*event_group is null/i);
  assert.doesNotMatch(migrationSql, /set\s+(?:label|cardinal_entry|silver_entry|result)\s*=/i);
});

test('summarizeLegacyLedger reconciles a complete 2024-style ledger to 43 points', () => {
  assert.equal(typeof summarizeLegacyLedger, 'function');
  const summary = summarizeLegacyLedger({
    expected_points: 43,
    cardinal_total: 23.5,
    silver_total: 19.5,
    score_confidence: 'confirmed',
    legacy_results: [
      { label: 'Early events', points_available: 31, cardinal_points: 16, silver_points: 15 },
      { label: 'Singles', points_available: 12, cardinal_points: 7.5, silver_points: 4.5 },
    ],
  });
  assert.equal(summary.expectedPoints, 43);
  assert.equal(summary.blueTotal, 23.5);
  assert.equal(summary.whiteTotal, 19.5);
  assert.equal(summary.recordedPoints, 43);
  assert.equal(summary.unresolvedPoints, 0);
  assert.equal(summary.reconciled, true);
});

test('summarizeLegacyLedger reports the seven-point 2025 gap and row gaps', () => {
  const summary = summarizeLegacyLedger({
    expected_points: 52,
    cardinal_total: 23.5,
    silver_total: 21.5,
    score_confidence: 'unresolved',
    legacy_results: [
      { label: 'Recorded', points_available: 45, cardinal_points: 23.5, silver_points: 21.5 },
      { label: 'Missing A', points_available: 4, cardinal_points: null, silver_points: null },
      { label: 'Missing B', points_available: 3, cardinal_points: null, silver_points: null },
    ],
  });
  assert.equal(summary.recordedPoints, 45);
  assert.equal(summary.unresolvedPoints, 7);
  assert.equal(summary.unresolvedRows, 2);
  assert.equal(summary.reconciled, false);
});

test('summarizeLegacyLedger preserves null totals and treats a one-sided award as partial', () => {
  const summary = summarizeLegacyLedger({
    expected_points: 2,
    cardinal_total: null,
    silver_total: null,
    legacy_results: [{ label: 'Partial', points_available: 2, cardinal_points: null, silver_points: 1 }],
  });
  assert.equal(summary.blueTotal, null);
  assert.equal(summary.whiteTotal, null);
  assert.equal(summary.rowBlueTotal, null);
  assert.equal(summary.rowWhiteTotal, 1);
  assert.equal(summary.rowAwardedPoints, 1);
  assert.equal(summary.recordedPoints, 1);
  assert.equal(summary.unresolvedPoints, 1);
  assert.equal(summary.unresolvedRows, 1);
});

test('summarizeLegacyLedger counts fully allocated rows whose source confidence remains unresolved', () => {
  const summary = summarizeLegacyLedger({
    expected_points: 2,
    cardinal_total: 2,
    silver_total: 0,
    score_confidence: 'confirmed',
    legacy_results: [{
      label: 'Conflicting source note',
      points_available: 2,
      cardinal_points: 2,
      silver_points: 0,
      confidence: 'unresolved',
    }],
  });
  assert.equal(summary.unresolvedRows, 1);
  assert.equal(summary.reconciled, true);
});

test('summarizeLegacyLedger flags over-allocation and reports row sums separately', () => {
  const over = { label: 'Over', points_available: 2, cardinal_points: 2, silver_points: 1 };
  const summary = summarizeLegacyLedger({
    expected_points: 4,
    cardinal_total: 2,
    silver_total: 2,
    score_confidence: 'confirmed',
    legacy_results: [over],
  });
  assert.deepEqual(summary.overAllocatedRows, [over]);
  assert.equal(summary.rowPointsAvailable, 2);
  assert.equal(summary.rowBlueTotal, 2);
  assert.equal(summary.rowWhiteTotal, 1);
  assert.equal(summary.rowAwardedPoints, 3);
  assert.equal(summary.rowTotalsMatchEdition, false);
  assert.equal(summary.reconciled, false);
});

test('groupLegacyResults keeps stable source order and falls back to Other results', () => {
  assert.equal(typeof groupLegacyResults, 'function');
  const unstructured = { label: 'Old row', sort_order: 5 };
  const laterInFirstGroup = { label: 'Second A', event_group: 'Match A', sort_order: 30, points_available: 2, confidence: 'confirmed' };
  const firstInSecondGroup = { label: 'First B', event_group: 'Match B', sort_order: 20, points_available: 1, confidence: 'unresolved' };
  const firstInFirstGroup = { label: 'First A', event_group: 'Match A', sort_order: 10, points_available: 2, confidence: 'confirmed' };
  const groups = groupLegacyResults([laterInFirstGroup, firstInSecondGroup, unstructured, firstInFirstGroup]);
  assert.deepEqual(groups.map(group => group.name), ['Other results', 'Match A', 'Match B']);
  assert.deepEqual(groups[1].results, [firstInFirstGroup, laterInFirstGroup]);
  assert.equal(groups[1].pointsAvailable, 4);
  assert.equal(groups[2].unresolvedRows, 1);
});
