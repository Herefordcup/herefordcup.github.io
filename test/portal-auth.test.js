import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../portal.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../src/portal.js', import.meta.url), 'utf8');

test('player access offers account creation, email signin, Google, and Apple', () => {
  for (const id of [
    'authModeSignIn',
    'authModeSignUp',
    'emailAuthForm',
    'displayNameField',
    'emailAddress',
    'emailPassword',
    'forgotPassword',
    'googleSignIn',
    'appleSignIn',
    'accessPendingView',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
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
    'signInWithApple',
    'requestPasswordReset',
    'setNewPassword',
    'canSetNewPassword',
    'waitForPasswordRecovery',
    'validateAuthInput',
    'hasActiveTournamentMembership',
  ]) {
    assert.match(script, new RegExp(`\\b${authMethod}\\b`), `missing ${authMethod}`);
  }
});
