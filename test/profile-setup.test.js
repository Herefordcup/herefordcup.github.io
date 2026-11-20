import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { avatarInitials, normalizeProfileInput, playerDisplayName, profileAvatarUrl } from '../src/profile.js';

const html = await readFile(new URL('../portal.html', import.meta.url), 'utf8');
const portalScript = await readFile(new URL('../src/portal.js', import.meta.url), 'utf8');

test('profile setup validates the display name and handicap index', () => {
  assert.deepEqual(normalizeProfileInput('  Jose Pimentel  ', '12.4'), {
    displayName: 'Jose Pimentel',
    handicapIndex: 12.4,
  });
  assert.throws(() => normalizeProfileInput('J', '12.4'), /display name/i);
  assert.throws(() => normalizeProfileInput('Jose', '55'), /handicap index/i);
});

test('profile avatar uses a safe Google photo or initials fallback', () => {
  assert.equal(avatarInitials('Jose Pimentel'), 'JP');
  assert.equal(avatarInitials('Jose'), 'J');
  assert.equal(profileAvatarUrl({ avatar_url: 'https://example.com/jose.jpg' }), 'https://example.com/jose.jpg');
  assert.equal(profileAvatarUrl({ picture: 'javascript:alert(1)' }), null);
});

test('signed-in header shows the player name and never their email address', () => {
  const googleUser = {
    email: 'private@example.com',
    user_metadata: { full_name: 'Google Golfer' },
  };

  assert.equal(playerDisplayName({ display_name: 'Hereford Player' }, googleUser), 'Hereford Player');
  assert.equal(playerDisplayName(null, googleUser), 'Google Golfer');
  assert.equal(playerDisplayName(null, { email: 'private@example.com', user_metadata: {} }), 'Player');
  assert.doesNotMatch(portalScript, /playerIdentity'\)\.textContent = session\.user\.email/);
  assert.match(portalScript, /playerIdentity'\)\.textContent = playerDisplayName\(playerData\.profile, session\.user\)/);
});

test('home profile control opens an accessible setup dialog', () => {
  for (const id of ['profileSetupButton', 'profileSetupDialog', 'profileSetupForm', 'profileDisplayName', 'profileHandicap', 'profileAvatar']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /Update your name, handicap index, and player picture/);
  assert.match(portalScript, /profileSetupDialog\.showModal\(\)/);
  assert.match(portalScript, /await saveProfile\(/);
  assert.match(portalScript, /renderProfileAvatar/);
});

test('profile setup loads a fresh script and has a non-dialog fallback', () => {
  assert.match(html, /src="src\/portal\.js\?v=membership-team-1"/);
  assert.match(portalScript, /from '\.\/profile\.js\?v=player-name-1'/);
  assert.match(html, /href="home\.css\?v=match-commentary-inline-1"/);
  assert.match(portalScript, /typeof profileSetupDialog\.showModal === 'function'/);
  assert.match(portalScript, /profileSetupDialog\.setAttribute\('open',\s*''\)/);
});
