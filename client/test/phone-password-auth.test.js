import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhonePasswordAuth } from '../src/lib/phone-password-auth.js';

function createAuthClient() {
  const calls = [];
  const client = {
    auth: {
      signUp: async (input) => {
        calls.push({ method: 'signUp', input });
        return {
          data: { user: { id: 'user-id' }, session: { access_token: 'signup-token' } },
          error: null,
        };
      },
      signInWithPassword: async (input) => {
        calls.push({ method: 'signInWithPassword', input });
        return {
          data: { user: { id: 'user-id' }, session: { access_token: 'login-token' } },
          error: null,
        };
      },
    },
  };
  return { client, calls };
}

test('registration creates a phone-password account without phone verification', async () => {
  const { client, calls } = createAuthClient();
  const auth = createPhonePasswordAuth(client);
  const metadata = { name: 'Lova R.', role: 'passenger', terms_accepted: true };

  const result = await auth.register({
    phone: '034 00 000 98',
    password: 'StrongPass2026!',
    metadata,
  });

  assert.equal(result.session.access_token, 'signup-token');
  assert.deepEqual(calls, [{
    method: 'signUp',
    input: {
      email: '261340000098@auth.drivenight.invalid',
      password: 'StrongPass2026!',
      options: { data: { ...metadata, phone: '+261340000098' } },
    },
  }]);
});

test('login resolves the normalized phone to its private auth identity', async () => {
  const { client, calls } = createAuthClient();
  const auth = createPhonePasswordAuth(client);

  const result = await auth.login({ phone: '+261 34 00 000 98', password: 'StrongPass2026!' });

  assert.equal(result.session.access_token, 'login-token');
  assert.deepEqual(calls, [{
    method: 'signInWithPassword',
    input: { email: '261340000098@auth.drivenight.invalid', password: 'StrongPass2026!' },
  }]);
});

test('login falls back to existing phone-auth accounts', async () => {
  const { client, calls } = createAuthClient();
  client.auth.signInWithPassword = async (input) => {
    calls.push({ method: 'signInWithPassword', input });
    if ('email' in input) {
      return { data: { user: null, session: null }, error: new Error('Invalid login credentials') };
    }
    return {
      data: { user: { id: 'legacy-user' }, session: { access_token: 'legacy-token' } },
      error: null,
    };
  };
  const auth = createPhonePasswordAuth(client);

  const result = await auth.login({ phone: '0340000098', password: 'StrongPass2026!' });

  assert.equal(result.session.access_token, 'legacy-token');
  assert.deepEqual(calls, [
    {
      method: 'signInWithPassword',
      input: { email: '261340000098@auth.drivenight.invalid', password: 'StrongPass2026!' },
    },
    { method: 'signInWithPassword', input: { phone: '+261340000098', password: 'StrongPass2026!' } },
  ]);
});

test('registration fails clearly when email confirmation blocks immediate login', async () => {
  const { client } = createAuthClient();
  client.auth.signUp = async () => ({
    data: { user: { id: 'user-id' }, session: null },
    error: null,
  });
  const auth = createPhonePasswordAuth(client);

  await assert.rejects(
    auth.register({
      phone: '0340000098',
      password: 'StrongPass2026!',
      metadata: {},
    }),
    (error) => error.message === 'EMAIL_CONFIRMATION_REQUIRED',
  );
});
