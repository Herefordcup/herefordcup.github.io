import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public and administrator interfaces label the teams Blue and White', () => {
  const index = read('index.html');
  const portal = read('portal.html');
  const admin = read('admin.html');
  const app = read('src/app.js');
  const adminScript = read('src/admin.js');

  assert.match(index, /<h3>Blue<\/h3>/);
  assert.match(index, /<h3>White<\/h3>/);
  assert.match(portal, /<span>Blue<\/span>[\s\S]*<span>White<\/span>/);
  assert.match(app, /TEAM BLUE/);
  assert.match(app, /TEAM WHITE/);
  assert.doesNotMatch(app, /wins next hole/);
  assert.match(adminScript, /new Option\('Blue side', 'cardinal'\)/);
  assert.match(adminScript, /new Option\('White side', 'silver'\)/);
  assert.match(admin, /Blue entry/);
  assert.match(admin, /White entry/);

  for (const source of [index, portal, admin, app, adminScript]) {
    assert.doesNotMatch(source, /(?:Team |TEAM |Pair |Player |side|entry|lead|wins |belong to )(?:Cardinal|Silver)|(?:Cardinal|Silver)(?: Pair| Player| side| entry| lead| wins| won)/i);
  }
});

test('public Blue team shield uses MIT dark blue', () => {
  const index = read('index.html');
  const styles = read('styles.css');

  assert.match(index, /styles\.css\?v=public-preview-1/i);
  assert.match(styles, /--team-blue:#002896/i);
  assert.match(styles, /\.team-cardinal \.team-code\{background:var\(--team-blue\)\}/i);
});
