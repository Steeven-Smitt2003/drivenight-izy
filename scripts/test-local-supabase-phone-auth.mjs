import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const status = execFileSync('npx', ['supabase', 'status', '--output', 'env'], {
  encoding: 'utf8',
});
const config = Object.fromEntries(
  status
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [
        line.slice(0, separator),
        line.slice(separator + 1).replace(/^["']|["']$/g, ''),
      ];
    }),
);
const { API_URL: apiUrl, ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceKey } = config;

assert.ok(apiUrl && anonKey && serviceKey, 'Local Supabase credentials are unavailable');

async function request(path, { method = 'GET', body, key = anonKey, bearer = key } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

const createdUsers = [];

try {
  const { status: settingsStatus, body: settings } = await request('/auth/v1/settings');
  assert.equal(settingsStatus, 200);
  assert.equal(settings.external?.email, true, 'Supabase Email auth must be enabled for private phone identities');
  assert.equal(settings.mailer_autoconfirm, true, 'Email confirmation must be disabled for immediate registration');
  assert.equal(settings.external?.phone, false, 'Phone auth must not be required for registration');

  for (const role of ['passenger', 'driver']) {
    const phone = `+2613${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
    const authEmail = `${phone.slice(1)}@auth.drivenight.invalid`;
    const password = `DriveNight-test-${crypto.randomUUID()}`;
    const name = 'DriveNight local auth regression';
    const signup = await request('/auth/v1/signup', {
      method: 'POST',
      body: {
        email: authEmail,
        password,
        data: {
          name,
          role,
          phone,
          terms_accepted: true,
          ...(role === 'driver' ? {
            vehicle_category: 'moto',
            vehicle_registration: `DNY${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
          } : {}),
        },
      },
    });

    assert.ok(signup.status >= 200 && signup.status < 300, `Phone sign-up failed for ${role}`);
    const user = signup.body?.user ?? signup.body;
    assert.ok(user?.id, `Supabase did not return a user for ${role}`);
    createdUsers.push({ id: user.id, name });
    assert.ok(signup.body?.access_token, `Phone sign-up required confirmation for ${role}`);
    assert.ok(!user.phone, 'The synthetic email identity must not set an Auth phone number');

    const login = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: authEmail, password },
    });
    assert.equal(login.status, 200, `Password login failed for ${role}`);
    assert.equal(login.body?.user?.id, user.id, `Phone password login returned another ${role} identity`);

    const profile = await request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,name,role,phone,email`,
      { key: serviceKey, bearer: serviceKey },
    );
    assert.equal(profile.status, 200);
    assert.equal(profile.body?.length, 1, `Profile trigger did not create the ${role} profile`);
    assert.equal(profile.body[0].name, name);
    assert.equal(profile.body[0].role, role);
    assert.equal(profile.body[0].phone, phone);
    assert.equal(profile.body[0].email, null, 'The synthetic auth email must not leak into the profile');

    if (role === 'passenger') {
      const duplicate = await request('/auth/v1/signup', {
        method: 'POST',
        body: {
          email: authEmail,
          password: `DriveNight-duplicate-${crypto.randomUUID()}`,
          data: { name, role, phone, terms_accepted: true },
        },
      });
      if (duplicate.body?.user?.id && duplicate.body.user.id !== user.id) {
        createdUsers.push({ id: duplicate.body.user.id, name: 'DriveNight duplicate-phone test' });
      }
      assert.ok(!duplicate.body?.access_token, 'Supabase accepted a duplicate phone number');
    }

    console.log(`PASS phone/password signup, immediate session, login, and profile creation without SMS: ${role}`);
  }
} finally {
  for (const user of createdUsers) {
    console.log(`pre-delete test account: ${user.name} (${user.id})`);
    const deletion = await request(`/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      key: serviceKey,
      bearer: serviceKey,
    });
    assert.ok(
      deletion.status === 200 || deletion.status === 204,
      `Could not remove listed synthetic test account ${user.id}`,
    );
  }
}
