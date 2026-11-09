import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const jwtSecret = 'test-secret-with-more-than-32-characters';

async function createTestApp(t) {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret,
  });
  t.after(() => app.close());
  return app;
}

test('a passenger account is created immediately with a unique phone and password', async (t) => {
  const app = await createTestApp(t);
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      name: 'Lova R.',
      phone: '034 00 000 98',
      role: 'passenger',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });

  assert.equal(registration.statusCode, 201);
  assert.equal(registration.json().user.name, 'Lova R.');
  assert.equal(registration.json().user.phone, '+261340000098');
  assert.equal(registration.json().user.role, 'passenger');
  assert.equal(registration.json().user.email, null);
  assert.equal(registration.json().user.emailVerified, false);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { phone: '+261340000098', password: 'StrongPass2026!' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.id, registration.json().user.id);
});

test('two people with the same name can register and sign in by their distinct phones', async (t) => {
  const app = await createTestApp(t);
  const accounts = [
    { phone: '0340000096', password: 'StrongPass2026!' },
    { phone: '0340000097', password: 'AnotherPass2026!' },
  ];

  for (const account of accounts) {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Miora Rakoto',
        ...account,
        role: 'passenger',
        termsAccepted: true,
      },
    });
    assert.equal(registration.statusCode, 201);
  }

  for (const account of accounts) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone: account.phone, password: account.password },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().user.name, 'Miora Rakoto');
    assert.equal(login.json().user.phone, `+261${account.phone.slice(1)}`);
  }

  const ambiguousNameLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: accounts[0].password },
  });
  assert.equal(ambiguousNameLogin.statusCode, 401);
});

test('registration rejects a phone number already in use, including equivalent formatting', async (t) => {
  const app = await createTestApp(t);
  const payload = {
    name: 'Lova R.',
    phone: '0340000095',
    role: 'passenger',
    password: 'StrongPass2026!',
    termsAccepted: true,
  };
  const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...payload, phone: '+261 34 00 000 95' },
  });

  assert.equal(first.statusCode, 201);
  assert.equal(duplicate.statusCode, 409);
  assert.deepEqual(duplicate.json(), { error: 'ACCOUNT_ALREADY_EXISTS' });
});

test('a driver can create a complete vehicle profile without a verification challenge', async (t) => {
  const app = await createTestApp(t);
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      name: 'Tiana R.',
      phone: '0340000094',
      role: 'driver',
      password: 'StrongPass2026!',
      termsAccepted: true,
      vehicleCategory: 'moto',
      vehicleRegistration: '1234 TAA',
    },
  });

  assert.equal(registration.statusCode, 201);
  assert.equal(registration.json().user.role, 'driver');
  assert.equal(registration.json().user.vehicleCategory, 'moto');
  assert.equal(registration.json().user.vehicleRegistration, '1234 TAA');
});
