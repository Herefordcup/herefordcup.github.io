import test from 'node:test';
import assert from 'node:assert/strict';

import * as supabaseModule from '../src/supabase.js';

test('auth module exposes email and Google entry points', () => {
  for (const name of [
    'createAuthActions',
    'canSetNewPassword',
    'signUpWithEmail',
    'signInWithEmail',
    'signInWithGoogle',
    'requestPasswordReset',
    'setNewPassword',
    'waitForPasswordRecovery',
  ]) {
    assert.equal(typeof supabaseModule[name], 'function', `${name} should be exported`);
  }
  assert.equal('signInWithApple' in supabaseModule, false);
});

test('email signup normalizes identity and stores the chosen display name', async () => {
  const calls = [];
  const client = {
    auth: {
      signUp: async payload => {
        calls.push(payload);
        return { data: { user: { id: 'player-1' } }, error: null };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client, {
    emailRedirectTo: 'https://example.test/portal.html',
  });

  const result = await auth.signUpWithEmail({
    email: '  Golfer@Example.com ',
    password: 'correct horse battery staple',
    displayName: '  Alex Golfer  ',
  });

  assert.equal(result.user.id, 'player-1');
  assert.deepEqual(calls, [{
    email: 'golfer@example.com',
    password: 'correct horse battery staple',
    options: {
      emailRedirectTo: 'https://example.test/portal.html',
      data: { display_name: 'Alex Golfer', full_name: 'Alex Golfer' },
    },
  }]);
});

test('email signin normalizes the email address', async () => {
  const calls = [];
  const client = {
    auth: {
      signInWithPassword: async payload => {
        calls.push(payload);
        return { data: { session: { access_token: 'session' } }, error: null };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client);

  const result = await auth.signInWithEmail(' Golfer@Example.com ', 'secret-password');

  assert.equal(result.session.access_token, 'session');
  assert.deepEqual(calls, [{ email: 'golfer@example.com', password: 'secret-password' }]);
});

test('social signin allows only Google and returns to the portal', async () => {
  const calls = [];
  const client = {
    auth: {
      signInWithOAuth: async payload => {
        calls.push(payload);
        return { data: { provider: payload.provider }, error: null };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client, {
    oauthRedirectTo: 'https://example.test/portal.html',
  });

  await auth.signInWithProvider('google');
  await assert.rejects(() => auth.signInWithProvider('apple'), /Unsupported sign-in provider/);
  await assert.rejects(() => auth.signInWithProvider('facebook'), /Unsupported sign-in provider/);

  assert.deepEqual(calls, [
    { provider: 'google', options: { redirectTo: 'https://example.test/portal.html' } },
  ]);
});

test('password recovery sends the user back to the portal', async () => {
  const calls = [];
  const client = {
    auth: {
      resetPasswordForEmail: async (email, options) => {
        calls.push({ email, options });
        return { data: {}, error: null };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client, {
    passwordResetRedirectTo: 'https://example.test/portal.html?recovery=1',
  });

  await auth.requestPasswordReset(' Golfer@Example.com ');

  assert.deepEqual(calls, [{
    email: 'golfer@example.com',
    options: { redirectTo: 'https://example.test/portal.html?recovery=1' },
  }]);
});

test('signup validation reports missing identity and weak passwords', () => {
  assert.deepEqual(supabaseModule.validateAuthInput({
    mode: 'signup',
    displayName: ' ',
    email: 'not-an-email',
    password: 'short',
  }), {
    displayName: 'Enter your name.',
    email: 'Enter a valid email address.',
    password: 'Use at least 8 characters.',
  });
});

test('signin validation accepts a valid email and password', () => {
  assert.deepEqual(supabaseModule.validateAuthInput({
    mode: 'signin',
    email: 'golfer@example.com',
    password: 'eight-or-more',
  }), {});
});

test('tournament access requires at least one active membership', () => {
  assert.equal(supabaseModule.hasActiveTournamentMembership([]), false);
  assert.equal(supabaseModule.hasActiveTournamentMembership([{ status: 'pending' }]), false);
  assert.equal(supabaseModule.hasActiveTournamentMembership([{ status: 'active' }]), true);
});

test('password recovery validates and saves a new password', async () => {
  const calls = [];
  const client = {
    auth: {
      updateUser: async values => {
        calls.push(values);
        return { data: { user: { id: 'player-1' } }, error: null };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client);

  assert.deepEqual(supabaseModule.validateAuthInput({
    mode: 'recovery',
    password: 'new-password',
  }), {});
  const result = await auth.setNewPassword('new-password');

  assert.equal(result.user.id, 'player-1');
  assert.deepEqual(calls, [{ password: 'new-password' }]);
});

test('password reset mode requires Supabase PASSWORD_RECOVERY proof', async () => {
  let listener;
  let unsubscribed = false;
  const client = {
    auth: {
      onAuthStateChange: callback => {
        listener = callback;
        return {
          data: {
            subscription: { unsubscribe: () => { unsubscribed = true; } },
          },
        };
      },
    },
  };
  const auth = supabaseModule.createAuthActions(client);
  let settled = false;
  const recovery = auth.waitForPasswordRecovery(1000).then(value => {
    settled = true;
    return value;
  });

  listener('SIGNED_IN', { user: { id: 'ordinary-session' } });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(supabaseModule.canSetNewPassword('recovery', false), false);

  listener('PASSWORD_RECOVERY', { user: { id: 'recovering-user' } });
  const session = await recovery;
  assert.equal(session.user.id, 'recovering-user');
  assert.equal(unsubscribed, true);
  assert.equal(supabaseModule.canSetNewPassword('recovery', true), true);
  assert.equal(supabaseModule.canSetNewPassword('signin', true), false);
});
