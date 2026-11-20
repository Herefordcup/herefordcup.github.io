import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../portal.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../src/portal.js', import.meta.url), 'utf8');

test('player access offers account creation, email signin, and Google', () => {
  for (const id of [
    'authModeSignIn',
    'authModeSignUp',
    'emailAuthForm',
    'displayNameField',
    'emailAddress',
    'emailPassword',
    'forgotPassword',
    'googleSignIn',
    'accessPendingView',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']appleSignIn["']/);
  assert.doesNotMatch(html, />\s*Apple\s*</);
});

test('signed-in portal header offers every player a Home link beside account controls', () => {
  assert.match(html, /id="publicHomeLink"[^>]*href="index\.html"[^>]*hidden[^>]*>Home<\/a>/);
  assert.match(script, /document\.querySelector\('#publicHomeLink'\)\.hidden = false/);
});

test('email signup explains verification before administrator approval', () => {
  assert.match(script, /First, verify your email\. Then return here and sign in\. After you sign in, your membership request will be sent to an administrator for approval\./);
});

test('registered accounts remain pending until an administrator approves them', () => {
  assert.match(html, /new player accounts require administrator approval/i);
  assert.match(html, /administrator must approve your membership/i);
  assert.doesNotMatch(html, /automatically carries into every Hereford Cup tournament/i);
  assert.doesNotMatch(html, /automatically receive access when a tournament is available/i);
});

test('portal remains a browser website without install metadata', () => {
  assert.doesNotMatch(html, /rel=["']manifest["']/i);
  assert.doesNotMatch(html, /serviceWorker\.register/);
});

test('portal wires every account method to the Supabase auth layer', () => {
  for (const authMethod of [
    'signUpWithEmail',
    'signInWithEmail',
    'signInWithGoogle',
    'requestPasswordReset',
    'setNewPassword',
    'canSetNewPassword',
    'waitForPasswordRecovery',
    'validateAuthInput',
    'hasActiveTournamentMembership',
  ]) {
    assert.match(script, new RegExp(`\\b${authMethod}\\b`), `missing ${authMethod}`);
  }
  assert.doesNotMatch(script, /\bsignInWithApple\b/);
});
