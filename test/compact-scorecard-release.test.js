import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = path => readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('both authenticated scorecard surfaces ship the compact editor styles; the public pages do not',async()=>{
  const css='href="scorecard-edit.css?v=compact-scorecard-1"';
  for (const page of ['admin.html','portal.html']) assert.ok((await read(page)).includes(css),page);
  for (const page of ['index.html','past-trips.html']) assert.ok(!(await read(page)).includes(css),page);
});
