import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const targetRoot = process.argv[2];
if (!targetRoot) throw new Error('Expected a disposable target work directory.');

const sourceRoot = resolve('supabase');
const targetSupabase = resolve(targetRoot, 'supabase');
if (targetSupabase === sourceRoot || !targetSupabase.startsWith(resolve(targetRoot))) {
  throw new Error('Refusing to modify the repository Supabase directory.');
}

await rm(targetSupabase, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await cp(sourceRoot, targetSupabase, { recursive: true });
await rm(resolve(targetSupabase, '.temp'), { recursive: true, force: true });

// Supabase CLI 3 runs local migrations without an implicit transaction. Migration
// 006 predates that behavior and intentionally uses LOCK TABLE, so wrap the
// disposable copy without changing the already-applied production migration.
const migrationPath = resolve(targetSupabase, 'migrations', '006_automatic_tournament_access.sql');
const migration = await readFile(migrationPath, 'utf8');
if (!/^\s*-- Give every registered Hereford Cup account access/m.test(migration)
  || !/lock table auth\.users in share row exclusive mode;/i.test(migration)
  || /^\s*begin;/i.test(migration)) {
  throw new Error('Migration 006 no longer matches the reviewed transaction-wrapper contract.');
}
await writeFile(migrationPath, `begin;\n\n${migration.trim()}\n\ncommit;\n`);
