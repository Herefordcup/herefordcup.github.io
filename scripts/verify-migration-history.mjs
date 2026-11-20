import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASELINE_VERSIONS = Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, '0'));

export function localMigrationVersions(directory = new URL('../supabase/migrations/', import.meta.url)) {
  return readdirSync(directory)
    .map(name => /^(\d+)_.*\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
}

export function remoteMigrationVersions(output) {
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain.split(/\r?\n/);
  const cells = line => line.split('|').map(cell => cell.replaceAll('`', '').trim());
  const headerIndex = lines.findIndex(line => {
    const [local, remote] = cells(line);
    return /^Local$/i.test(local ?? '') && /^Remote$/i.test(remote ?? '');
  });
  if (headerIndex < 0) throw new Error('Supabase migration list output is missing the Local/Remote header');

  const versions = [];
  let rowCount = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.includes('|')) continue;
    const [local = '', remote = ''] = cells(line);
    if (/^-+$/.test(local) && /^-+$/.test(remote)) continue;
    if ((!local && !remote) || (local && !/^\d+$/.test(local)) || (remote && !/^\d+$/.test(remote))) {
      throw new Error(`Unrecognized Supabase migration row: ${line.trim()}`);
    }
    rowCount += 1;
    if (remote) versions.push(remote);
  }
  if (!rowCount) throw new Error('Supabase migration list output contains no migration rows');
  return versions;
}

function requireExact(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: expected [${expected.join(', ')}], received [${actual.join(', ')}]`);
  }
}

export function verifyMigrationHistory(mode, output, local = localMigrationVersions()) {
  const remote = remoteMigrationVersions(output);
  requireExact(local.slice(0, BASELINE_VERSIONS.length), BASELINE_VERSIONS, 'Local baseline is not 001-028');

  if (mode === 'empty') {
    requireExact(remote, [], 'Remote history must be empty before bootstrap');
  } else if (mode === 'baseline') {
    requireExact(remote, BASELINE_VERSIONS, 'Remote bootstrap history must be exactly 001-028');
    if (remote.includes('029')) throw new Error('Migration 029 must remain pending after bootstrap');
  } else if (mode === 'prefix') {
    if (remote.length < BASELINE_VERSIONS.length) throw new Error('Remote history is missing the verified 001-028 baseline');
    requireExact(remote, local.slice(0, remote.length), 'Remote history is not a valid local migration prefix');
  } else if (mode === 'complete') {
    requireExact(remote, local, 'Remote history does not match every checked-out migration');
  } else {
    throw new Error(`Unknown verification mode: ${mode}`);
  }
  return { local, remote };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  const input = readFileSync(0, 'utf8');
  const result = verifyMigrationHistory(mode, input);
  console.log(`Migration history verified (${mode}): ${result.remote.join(', ') || 'empty'}`);
}
