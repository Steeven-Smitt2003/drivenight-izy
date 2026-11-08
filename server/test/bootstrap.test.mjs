import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/db/index.mjs';

test('the local health endpoint reports the API and SQLite as ready', async (t) => {
  const app = await createApp({ databasePath: ':memory:', logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    database: 'ready',
  });
});

test('hosted API CORS allows only the configured client origin', async (t) => {
  const allowedOrigin = 'https://drivenight.pages.dev';
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    clientOrigin: allowedOrigin,
  });
  t.after(() => app.close());

  const allowedResponse = await app.inject({
    method: 'OPTIONS',
    url: '/api/health',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  const deniedResponse = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { origin: 'https://not-drivenight.example' },
  });

  assert.equal(allowedResponse.statusCode, 204);
  assert.equal(allowedResponse.headers['access-control-allow-origin'], allowedOrigin);
  assert.equal(deniedResponse.headers['access-control-allow-origin'], undefined);
});

test('initializing a fresh database more than once keeps the demo seed intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-db-'));
  const databasePath = join(directory, 'test.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = openDatabase(databasePath);
  first.close();
  const second = openDatabase(databasePath);

  t.after(() => second.close());
  assert.equal(second.prepare('SELECT COUNT(*) AS count FROM users').get().count, 6);
  assert.equal(second.prepare('SELECT COUNT(*) AS count FROM rides').get().count, 3);
  assert.equal(second.prepare('SELECT COUNT(*) AS count FROM driver_vehicles').get().count, 3);
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(second.prepare(
    "SELECT COUNT(*) AS count FROM driver_profiles WHERE validation_status <> 'approved'",
  ).get().count, 0);
});

test('existing version-one accounts survive all schema migrations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-migration-'));
  const databasePath = join(directory, 'legacy.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(readFileSync(
    new URL('../src/db/migrations/001_initial.sql', import.meta.url),
    'utf8',
  ));
  legacyDatabase.exec(`
    INSERT INTO users (id, phone, role, name) VALUES
      ('demo-passenger-01', '+261340000001', 'passenger', 'Miora Rakoto'),
      ('demo-passenger-02', '+261340000002', 'passenger', 'Hery Randria'),
      ('demo-driver-01', '+261340000011', 'driver', 'Tiana Rasoanaivo'),
      ('demo-driver-02', '+261340000012', 'driver', 'Fanja Andriam'),
      ('demo-driver-03', '+261340000013', 'driver', 'Toky Rakoto'),
      ('demo-admin-01', '+261340000099', 'admin', 'Admin DriveNight');
  `);
  legacyDatabase.pragma('user_version = 1');
  legacyDatabase.close();

  const migratedDatabase = openDatabase(databasePath);
  t.after(() => migratedDatabase.close());

  assert.equal(migratedDatabase.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(migratedDatabase.prepare('SELECT COUNT(*) AS count FROM users').get().count, 6);
  assert.equal(
    migratedDatabase.prepare('SELECT email FROM users WHERE id = ?').get('demo-passenger-01').email,
    null,
  );
  assert.notEqual(
    migratedDatabase.prepare('SELECT password_hash FROM users WHERE id = ?').get('demo-passenger-01').password_hash,
    null,
  );
});

test('a passenger can sign in with their name and password', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      identifier: 'Miora Rakoto',
      password: 'DriveNight2026!',
    },
  });

  assert.equal(loginResponse.statusCode, 200);
  assert.equal(typeof loginResponse.json().token, 'string');

  const profileResponse = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${loginResponse.json().token}` },
  });

  assert.equal(profileResponse.statusCode, 200);
  assert.deepEqual(profileResponse.json(), {
    id: 'demo-passenger-01',
    phone: '+261340000001',
    email: null,
    emailVerified: false,
    role: 'passenger',
    name: 'Miora Rakoto',
    photoUrl: null,
    averageRating: 5,
    ratingCount: 1,
    termsAcceptedAt: null,
    termsVersion: null,
    vehicleCategory: null,
    vehicleRegistration: null,
    activeVehicleId: null,
    vehicles: [],
  });
});

test('a driver account keeps one vehicle and refuses a second one', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
  });
  const headers = { authorization: `Bearer ${login.json().token}` };
  const profile = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().vehicles.length, 1);
  assert.equal(profile.json().vehicles[0].category, 'voiture');
  const addedVehicle = await app.inject({
    method: 'POST',
    url: '/api/driver/vehicles',
    headers,
    payload: { category: 'moto', vehicleRegistration: 'NEW-005' },
  });
  assert.equal(addedVehicle.statusCode, 409);
  assert.deepEqual(addedVehicle.json(), { error: 'VEHICLE_LIMIT_REACHED' });

  const rides = await app.inject({ method: 'GET', url: '/api/driver/rides', headers });
  assert.equal(rides.statusCode, 200);
  assert.ok(rides.json().rides.every((ride) => ride.category === 'voiture'));
});

test('database migration keeps the active vehicle when removing a driver’s extra vehicle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-single-vehicle-'));
  const databasePath = join(directory, 'legacy.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const legacyDatabase = new Database(databasePath);
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    legacyDatabase.exec(readFileSync(
      new URL(`../src/db/migrations/00${version}_${[
        '',
        'initial',
        'user_email',
        'user_password',
        'user_terms_consent',
        'driver_vehicle_details',
        'ride_locations',
        'driver_vehicles',
      ][version]}.sql`, import.meta.url),
      'utf8',
    ));
    legacyDatabase.pragma(`user_version = ${version}`);
  }
  const legacySeedSql = readFileSync(new URL('../src/db/seed.sql', import.meta.url), 'utf8')
    .replace(
      /(INSERT INTO driver_vehicles[\s\S]*?)ON CONFLICT \(user_id\) DO NOTHING;/,
      '$1ON CONFLICT (user_id, category) DO NOTHING;',
    );
  legacyDatabase.exec(legacySeedSql);
  legacyDatabase.prepare(`
    INSERT INTO driver_vehicles (
      id, user_id, category, vehicle_registration
    ) VALUES ('legacy-extra-vehicle', 'demo-driver-01', 'moto', 'OLD-MOTO-01')
  `).run();
  legacyDatabase.close();

  const app = await createApp({
    databasePath,
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
  });
  const profile = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: 'Bearer ' + login.json().token },
  });

  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().vehicles.length, 1);
  assert.equal(profile.json().vehicles[0].id, 'demo-driver-01-vehicle');
  assert.equal(profile.json().vehicles[0].registration, 'DEMO-001');
  assert.equal(profile.json().activeVehicleId, 'demo-driver-01-vehicle');
});

test('a driver can update their profile, verify a new email and change password', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = async (identifier, password = 'DriveNight2026!') => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier, password },
  });
  const session = await login('Tiana Rasoanaivo');
  const headers = { authorization: `Bearer ${session.json().token}` };

  const updatedProfile = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile',
    headers,
    payload: { name: 'Tiana R.' },
  });
  assert.equal(updatedProfile.statusCode, 200);
  assert.equal(updatedProfile.json().profile.name, 'Tiana R.');

  const emailChallenge = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/request',
    headers,
    payload: { email: 'tiana.updated@example.test' },
  });
  assert.equal(emailChallenge.statusCode, 200);
  const emailVerification = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/verify',
    headers,
    payload: {
      challengeId: emailChallenge.json().challengeId,
      otp: emailChallenge.json().otp,
    },
  });
  assert.equal(emailVerification.statusCode, 200);
  assert.equal(emailVerification.json().profile.email, 'tiana.updated@example.test');
  assert.equal(emailVerification.json().profile.emailVerified, true);

  const passwordChange = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile/password',
    headers,
    payload: {
      currentPassword: 'DriveNight2026!',
      newPassword: 'NewStrongPass2026!',
    },
  });
  assert.equal(passwordChange.statusCode, 200);
  assert.equal((await login('tiana.updated@example.test')).statusCode, 401);
  assert.equal((await login('tiana.updated@example.test', 'NewStrongPass2026!')).statusCode, 200);

  const wrongCurrentPassword = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile/password',
    headers,
    payload: {
      currentPassword: 'not-the-current-password',
      newPassword: 'AnotherStrongPass2026!',
    },
  });
  assert.equal(wrongCurrentPassword.statusCode, 400);
  assert.deepEqual(wrongCurrentPassword.json(), { error: 'CURRENT_PASSWORD_INVALID' });
});

test('a passenger can update their profile, verify a new email and change password', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-passenger-profile-'));
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    uploadsDirectory: directory,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const login = async (identifier, password = 'DriveNight2026!') => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier, password },
  });
  const session = await login('Miora Rakoto');
  const headers = { authorization: `Bearer ${session.json().token}` };

  const updatedProfile = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile',
    headers,
    payload: {
      name: 'Miora R.',
      profilePhoto: 'data:image/jpeg;base64,/9j/2Q==',
    },
  });
  assert.equal(updatedProfile.statusCode, 200);
  assert.equal(updatedProfile.json().profile.name, 'Miora R.');
  assert.match(updatedProfile.json().profile.photoUrl, /^\/api\/media\/[0-9a-f-]+\.jpg$/);

  const phoneChallenge = await app.inject({
    method: 'POST',
    url: '/api/account/profile/phone/request',
    headers,
    payload: { phone: '+261 34 000 00 21' },
  });
  assert.equal(phoneChallenge.statusCode, 200);
  assert.equal(phoneChallenge.json().delivery, 'sms-simulated');
  const phoneVerification = await app.inject({
    method: 'POST',
    url: '/api/account/profile/phone/verify',
    headers,
    payload: {
      challengeId: phoneChallenge.json().challengeId,
      otp: phoneChallenge.json().otp,
    },
  });
  assert.equal(phoneVerification.statusCode, 200);
  assert.equal(phoneVerification.json().profile.phone, '+261340000021');
  assert.equal((await login('+261340000001')).statusCode, 401);
  assert.equal((await login('+261340000021')).statusCode, 200);

  const emailChallenge = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/request',
    headers,
    payload: { email: 'miora.updated@example.test' },
  });
  assert.equal(emailChallenge.statusCode, 200);
  const emailVerification = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/verify',
    headers,
    payload: {
      challengeId: emailChallenge.json().challengeId,
      otp: emailChallenge.json().otp,
    },
  });
  assert.equal(emailVerification.statusCode, 200);
  assert.equal(emailVerification.json().profile.email, 'miora.updated@example.test');
  assert.equal(emailVerification.json().profile.emailVerified, true);

  const passwordChange = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile/password',
    headers,
    payload: {
      currentPassword: 'DriveNight2026!',
      newPassword: 'NewPassengerPass2026!',
    },
  });
  assert.equal(passwordChange.statusCode, 200);
  assert.equal((await login('miora.updated@example.test')).statusCode, 401);
  assert.equal((await login('miora.updated@example.test', 'NewPassengerPass2026!')).statusCode, 200);
});

test('only an administrator can manage passenger and driver accounts', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = async (identifier) => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier, password: 'DriveNight2026!' },
  });
  const [adminLogin, passengerLogin, driverLogin] = await Promise.all([
    login('Admin DriveNight'),
    login('Miora Rakoto'),
    login('Tiana Rasoanaivo'),
  ]);
  const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };

  const driverHeaders = { authorization: 'Bearer ' + driverLogin.json().token };
  const accountsResponse = await app.inject({
    method: 'GET',
    url: '/api/admin/accounts',
    headers: adminHeaders,
  });
  assert.equal(accountsResponse.statusCode, 200);
  assert.deepEqual(accountsResponse.json().accounts.map(({ id, role }) => ({ id, role })), [
    { id: 'demo-driver-01', role: 'driver' },
    { id: 'demo-driver-02', role: 'driver' },
    { id: 'demo-driver-03', role: 'driver' },
    { id: 'demo-admin-01', role: 'admin' },
    { id: 'demo-passenger-01', role: 'passenger' },
    { id: 'demo-passenger-02', role: 'passenger' },
  ]);
  assert.equal(accountsResponse.json().accounts[0].phone, '+261340000011');
  assert.equal(accountsResponse.json().accounts[0].vehicleRegistration, 'DEMO-001');
  const searchedAccounts = await app.inject({
    method: 'GET',
    url: '/api/admin/accounts?q=Tiana&role=driver&status=active',
    headers: adminHeaders,
  });
  assert.deepEqual(searchedAccounts.json().accounts.map(({ id }) => id), ['demo-driver-01']);

  const passengerForbidden = await app.inject({
    method: 'GET',
    url: '/api/admin/accounts',
    headers: passengerHeaders,
  });
  assert.equal(passengerForbidden.statusCode, 403);
  assert.deepEqual(passengerForbidden.json(), { error: 'ADMIN_REQUIRED' });
  const passengerCannotDisable = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-driver-03/status',
    headers: passengerHeaders,
    payload: { isActive: false },
  });
  assert.equal(passengerCannotDisable.statusCode, 403);

  const deactivate = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-passenger-01/status',
    headers: adminHeaders,
    payload: { isActive: false },
  });
  assert.equal(deactivate.statusCode, 200);
  assert.equal(deactivate.json().account.isActive, false);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: passengerHeaders,
  })).statusCode, 401);

  const blockedLogin = await login('Miora Rakoto');
  assert.equal(blockedLogin.statusCode, 401);
  const inactiveAccounts = await app.inject({
    method: 'GET',
    url: '/api/admin/accounts?status=inactive',
    headers: adminHeaders,
  });
  assert.equal(inactiveAccounts.statusCode, 200);
  assert(inactiveAccounts.json().accounts.some(({ id }) => id === 'demo-passenger-01'));

  const reactivate = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-passenger-01/status',
    headers: adminHeaders,
    payload: { isActive: true },
  });
  assert.equal(reactivate.statusCode, 200);
  assert.equal(reactivate.json().account.isActive, true);
  assert.equal((await login('Miora Rakoto')).statusCode, 200);

  const disableDriver = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-driver-01/status',
    headers: adminHeaders,
    payload: { isActive: false },
  });
  assert.equal(disableDriver.statusCode, 200);
  assert.equal(disableDriver.json().account.isOnline, false);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/driver/availability',
    headers: driverHeaders,
  })).statusCode, 403);
});

test('an administrator can review operations, presence, ratings, and create another administrator', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [adminLogin, passengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Admin DriveNight', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
  ]);
  const adminHeaders = { authorization: 'Bearer ' + adminLogin.json().token };
  const passengerHeaders = { authorization: 'Bearer ' + passengerLogin.json().token };

  assert.equal((await app.inject({
    method: 'POST',
    url: '/api/presence',
    headers: passengerHeaders,
  })).statusCode, 204);
  const operations = await app.inject({
    method: 'GET',
    url: '/api/admin/operations',
    headers: adminHeaders,
  });
  assert.equal(operations.statusCode, 200);
  assert(operations.json().requests.some(({ id }) => id === 'demo-ride-02'));
  assert(operations.json().onlineDrivers.some(({ id, available }) => id === 'demo-driver-01' && available));
  assert(operations.json().onlinePassengers.some(({ id }) => id === 'demo-passenger-01'));
  assert.equal(operations.json().history.length, 3);
  assert(operations.json().ratings.some(({ stars }) => stars >= 1 && stars <= 5));

  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/admin/operations',
    headers: passengerHeaders,
  })).statusCode, 403);

  const createAdmin = await app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: adminHeaders,
    payload: {
      name: 'Admin secondaire',
      phone: '034 00 000 98',
      email: 'admin.secondaire@example.test',
      password: 'AdminSecondaire2026!',
    },
  });
  assert.equal(createAdmin.statusCode, 201);
  assert.equal(createAdmin.json().account.role, 'admin');
  const newAdminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'admin.secondaire@example.test', password: 'AdminSecondaire2026!' },
  });
  assert.equal(newAdminLogin.statusCode, 200);
  assert.equal(newAdminLogin.json().user.role, 'admin');

  const updateAdminProfile = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile',
    headers: { authorization: 'Bearer ' + newAdminLogin.json().token },
    payload: { name: 'Administratrice secondaire' },
  });
  assert.equal(updateAdminProfile.statusCode, 200);
  assert.equal(updateAdminProfile.json().profile.role, 'admin');
  const changeAdminPassword = await app.inject({
    method: 'PATCH',
    url: '/api/account/profile/password',
    headers: { authorization: 'Bearer ' + newAdminLogin.json().token },
    payload: { currentPassword: 'AdminSecondaire2026!', newPassword: 'AdminUpdated2026!' },
  });
  assert.equal(changeAdminPassword.statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'admin.secondaire@example.test', password: 'AdminUpdated2026!' },
  })).statusCode, 200);
});

test('account deactivation cancels open passenger requests but cannot interrupt an accepted ride', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = async (identifier) => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier, password: 'DriveNight2026!' },
  });
  const [adminLogin, passengerLogin, driverLogin] = await Promise.all([
    login('Admin DriveNight'),
    login('Miora Rakoto'),
    login('Tiana Rasoanaivo'),
  ]);
  const adminHeaders = { authorization: 'Bearer ' + adminLogin.json().token };
  const passengerHeaders = { authorization: 'Bearer ' + passengerLogin.json().token };
  const driverHeaders = { authorization: 'Bearer ' + driverLogin.json().token };
  const ride = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: passengerHeaders,
    payload: {
      origin: { label: 'Analakely', latitude: -18.9101, longitude: 47.5256 },
      destination: { label: 'Ivandry', latitude: -18.8687, longitude: 47.5502 },
      category: 'voiture',
      proposedPriceMGA: 5000,
    },
  });
  assert.equal(ride.statusCode, 201);

  const openRequestDeactivation = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-passenger-01/status',
    headers: adminHeaders,
    payload: { isActive: false },
  });
  assert.equal(openRequestDeactivation.statusCode, 200);
  const reactivateAfterOpenRequest = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-passenger-01/status',
    headers: adminHeaders,
    payload: { isActive: true },
  });
  assert.equal(reactivateAfterOpenRequest.statusCode, 200);
  const passengerAfterOpenRequestLogin = await login('Miora Rakoto');
  const rideHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
    headers: { authorization: 'Bearer ' + passengerAfterOpenRequestLogin.json().token },
  });
  assert.equal(rideHistory.statusCode, 200);
  assert(rideHistory.json().rides.some((item) => item.id === ride.json().ride.id && item.status === 'cancelled'));

  const renewedPassengerLogin = await login('Miora Rakoto');
  const renewedPassengerHeaders = { authorization: 'Bearer ' + renewedPassengerLogin.json().token };
  const openRide = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: renewedPassengerHeaders,
    payload: {
      origin: { label: 'Analakely', latitude: -18.9101, longitude: 47.5256 },
      destination: { label: 'Ivandry', latitude: -18.8687, longitude: 47.5502 },
      category: 'voiture',
      proposedPriceMGA: 5000,
    },
  });
  assert.equal(openRide.statusCode, 201);
  const acceptance = await app.inject({
    method: 'POST',
    url: `/api/rides/${encodeURIComponent(openRide.json().ride.id)}/accept`,
    headers: driverHeaders,
  });
  assert.equal(acceptance.statusCode, 201);
  const confirmedRide = await app.inject({
    method: 'POST',
    url: `/api/rides/${encodeURIComponent(openRide.json().ride.id)}/offers/${encodeURIComponent(acceptance.json().offer.id)}/accept`,
    headers: renewedPassengerHeaders,
  });
  assert.equal(confirmedRide.statusCode, 200);

  const blockedDeactivation = await app.inject({
    method: 'PATCH',
    url: '/api/admin/accounts/demo-passenger-01/status',
    headers: adminHeaders,
    payload: { isActive: false },
  });
  assert.equal(blockedDeactivation.statusCode, 409);
  assert.deepEqual(blockedDeactivation.json(), { error: 'ACCOUNT_HAS_ACTIVE_RIDE' });
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: renewedPassengerHeaders,
  })).statusCode, 200);
});

test('a passenger can publish a ride request with their own proposed price', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  const authorization = "Bearer " + login.json().token;
  const rideRequest = {
    origin: {
      label: 'Analakely, Antananarivo',
      latitude: -18.9087,
      longitude: 47.526,
    },
    destination: {
      label: 'Ivandry, Antananarivo',
      latitude: -18.8765,
      longitude: 47.5355,
    },
    category: 'taxi',
    proposedPriceMGA: 5200,
  };

  const response = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization },
    payload: rideRequest,
  });

  assert.equal(response.statusCode, 201);
  const { ride } = response.json();
  assert.match(ride.id, /^[0-9a-f-]{36}$/);
  assert.equal(ride.passengerId, 'demo-passenger-01');
  assert.deepEqual(ride.origin, rideRequest.origin);
  assert.deepEqual(ride.destination, rideRequest.destination);
  assert.equal(ride.category, 'taxi');
  assert.equal(ride.proposedPriceMGA, 5200);
  assert.equal(ride.status, 'searching');
  assert.match(ride.requestedAt, /^\d{4}-\d\d-\d\d/);

  const samePoint = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization },
    payload: {
      ...rideRequest,
      destination: rideRequest.origin,
    },
  });
  assert.equal(samePoint.statusCode, 400);
  assert.deepEqual(samePoint.json(), { error: 'ROUTE_POINTS_MUST_DIFFER' });

  const freelyChosenPrice = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization },
    payload: {
      ...rideRequest,
      proposedPriceMGA: 3_000_000_000,
      destination: {
        ...rideRequest.destination,
        label: 'Ambohibao, Antananarivo',
        latitude: -18.85,
        longitude: 47.48,
      },
    },
  });
  assert.equal(freelyChosenPrice.statusCode, 201);
  assert.equal(freelyChosenPrice.json().ride.proposedPriceMGA, 3_000_000_000);

  const blankAddress = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization },
    payload: {
      ...rideRequest,
      origin: { ...rideRequest.origin, label: '  ' },
    },
  });
  assert.equal(blankAddress.statusCode, 400);
  assert.deepEqual(blankAddress.json(), { error: 'PLACE_LABEL_REQUIRED' });

  const unauthorizedRide = await app.inject({
    method: 'POST',
    url: '/api/rides',
    payload: rideRequest,
  });
  assert.equal(unauthorizedRide.statusCode, 401);

  const driverLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
  });
  const driverResponse = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization: "Bearer " + driverLogin.json().token },
    payload: rideRequest,
  });
  assert.equal(driverResponse.statusCode, 403);
});

test('a passenger can cancel a ride before it starts and an unrelated passenger cannot', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [ownerLogin, otherLogin, driverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
  ]);
  const ownerHeaders = { authorization: `Bearer ${ownerLogin.json().token}` };
  const otherHeaders = { authorization: `Bearer ${otherLogin.json().token}` };
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };

  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/cancel',
    headers: otherHeaders,
  });
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(forbidden.json(), { error: 'RIDE_PARTICIPANT_REQUIRED' });

  const cancelled = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/cancel',
    headers: ownerHeaders,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().ride.status, 'cancelled');
  assert.ok(cancelled.json().ride.cancelledAt);

  const unavailable = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers: driverHeaders,
  });
  assert.ok(unavailable.json().rides.every(({ id }) => id !== 'demo-ride-02'));
});

test('a driver accepting the passenger price gives the passenger 15 seconds to confirm', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [login, passengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
  ]);
  const headers = { authorization: `Bearer ${login.json().token}` };
  const driverAcceptance = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/accept',
    headers,
  });

  assert.equal(driverAcceptance.statusCode, 201);
  assert.equal(driverAcceptance.json().offer.status, 'pending');
  assert.equal(driverAcceptance.json().offer.amountMGA, 8_000);
  assert.equal(driverAcceptance.json().offer.proposerId, 'demo-driver-02');
  assert.ok(Date.parse(driverAcceptance.json().offer.expiresAt) - Date.now() <= 15_000);
  assert.equal(driverAcceptance.json().ride.status, 'searching');
  assert.equal(driverAcceptance.json().ride.driverId, null);
  const acceptedOffers = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: `Bearer ${passengerLogin.json().token}` },
  });
  const pendingOffer = acceptedOffers.json().offers.find(({ id }) => id === driverAcceptance.json().offer.id);
  assert.equal(pendingOffer.status, 'pending');
  assert.equal(pendingOffer.proposer.name, 'Fanja Andriam');

  const passengerConfirmation = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${pendingOffer.id}/accept`,
    headers: { authorization: `Bearer ${passengerLogin.json().token}` },
  });
  assert.equal(passengerConfirmation.statusCode, 200);
  assert.equal(passengerConfirmation.json().ride.driverId, 'demo-driver-02');
  assert.equal(passengerConfirmation.json().ride.agreedPriceMGA, 8_000);
  assert.equal(passengerConfirmation.json().ride.status, 'driver_en_route');

  const repeatedAcceptance = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/accept',
    headers,
  });
  assert.equal(repeatedAcceptance.statusCode, 409);
  assert.deepEqual(repeatedAcceptance.json(), { error: 'RIDE_NOT_OPEN' });
});

test('a confirmed passenger offer hides other requests from that driver and keeps only the assigned ride active', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [driverLogin, passengerLogin, otherPassengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
  ]);
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const otherRequest = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: { authorization: `Bearer ${otherPassengerLogin.json().token}` },
    payload: {
      origin: { label: 'Analakely, Antananarivo', latitude: -18.9087, longitude: 47.526 },
      destination: { label: 'Ivandry, Antananarivo', latitude: -18.8765, longitude: 47.5355 },
      category: 'moto',
      proposedPriceMGA: 6_000,
    },
  });
  assert.equal(otherRequest.statusCode, 201);

  const pendingAcceptance = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/accept',
    headers: driverHeaders,
  });
  assert.equal(pendingAcceptance.statusCode, 201);
  const confirmedRide = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${pendingAcceptance.json().offer.id}/accept`,
    headers: passengerHeaders,
  });
  assert.equal(confirmedRide.statusCode, 200);

  const availableRides = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers: driverHeaders,
  });
  assert.deepEqual(availableRides.json().rides, []);
  const activeRides = await app.inject({
    method: 'GET',
    url: '/api/driver/active-rides',
    headers: driverHeaders,
  });
  assert.deepEqual(activeRides.json().rides.map(({ id }) => id), ['demo-ride-02']);
  const secondAcceptance = await app.inject({
    method: 'POST',
    url: `/api/rides/${otherRequest.json().ride.id}/accept`,
    headers: driverHeaders,
  });
  assert.equal(secondAcceptance.statusCode, 409);
  assert.deepEqual(secondAcceptance.json(), { error: 'DRIVER_HAS_ACTIVE_RIDE' });
});

test('an unconfirmed direct acceptance expires and makes the ride available again', async (t) => {
  let now = Date.now();
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    clock: () => now,
  });
  t.after(() => app.close());

  const [driverLogin, passengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
  ]);
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const acceptance = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/accept',
    headers: driverHeaders,
  });
  assert.equal(acceptance.statusCode, 201);

  now += 15_001;
  const offers = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: passengerHeaders,
  });
  assert.equal(
    offers.json().offers.find(({ id }) => id === acceptance.json().offer.id).status,
    'withdrawn',
  );
  const lateAcceptance = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${acceptance.json().offer.id}/accept`,
    headers: passengerHeaders,
  });
  assert.equal(lateAcceptance.statusCode, 409);
  assert.deepEqual(lateAcceptance.json(), { error: 'OFFER_NOT_ACCEPTABLE' });

  const availableRides = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers: driverHeaders,
  });
  assert.ok(availableRides.json().rides.some(({ id }) => id === 'demo-ride-02'));
});

test('a signed-in passenger or driver sees only their own rides in newest-first order', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passengerLogin, driverLogin, otherDriverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const otherDriverHeaders = { authorization: `Bearer ${otherDriverLogin.json().token}` };

  const passengerHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
    headers: passengerHeaders,
  });
  assert.equal(passengerHistory.statusCode, 200);
  assert.deepEqual(passengerHistory.json().rides.map(({ id, status, agreedPriceMGA, counterparty }) => ({
    id,
    status,
    agreedPriceMGA,
    counterparty: counterparty?.name ?? null,
  })), [
    { id: 'demo-ride-03', status: 'completed', agreedPriceMGA: 5000, counterparty: 'Fanja Andriam' },
    { id: 'demo-ride-01', status: 'completed', agreedPriceMGA: 14000, counterparty: 'Tiana Rasoanaivo' },
  ]);
  assert.equal('phone' in passengerHistory.json().rides[0].counterparty, false);

  const driverHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
    headers: driverHeaders,
  });
  assert.equal(driverHistory.statusCode, 200);
  assert.deepEqual(driverHistory.json().rides.map(({ id, counterparty }) => ({
    id,
    counterparty: counterparty?.name ?? null,
  })), [{ id: 'demo-ride-01', counterparty: 'Miora Rakoto' }]);

  const emptyHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
    headers: otherDriverHeaders,
  });
  assert.equal(emptyHistory.statusCode, 200);
  assert.deepEqual(emptyHistory.json().rides.map(({ id, counterparty }) => ({
    id,
    counterparty: counterparty?.name ?? null,
  })), [{ id: 'demo-ride-03', counterparty: 'Miora Rakoto' }]);

  const unauthorizedHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
  });
  assert.equal(unauthorizedHistory.statusCode, 401);
});

test('participants can rate the other person after a ride and the public rating is updated', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = async (identifier) => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier, password: 'DriveNight2026!' },
  });
  const [passengerLogin, otherPassengerLogin, driverLogin] = await Promise.all([
    login('Miora Rakoto'),
    login('Hery Randria'),
    login('Fanja Andriam'),
  ]);
  const headers = (response) => ({ authorization: `Bearer ${response.json().token}` });
  const passengerHeaders = headers(passengerLogin);
  const driverHeaders = headers(driverLogin);
  const otherPassengerHeaders = headers(otherPassengerLogin);

  const passengerRating = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-03/ratings',
    headers: passengerHeaders,
    payload: { stars: 4, comment: 'Trajet agréable et chauffeur ponctuel.' },
  });
  assert.equal(passengerRating.statusCode, 201);
  assert.deepEqual(passengerRating.json().rating, {
    id: passengerRating.json().rating.id,
    rideId: 'demo-ride-03',
    raterId: 'demo-passenger-01',
    rateeId: 'demo-driver-02',
    stars: 4,
    comment: 'Trajet agréable et chauffeur ponctuel.',
    createdAt: passengerRating.json().rating.createdAt,
  });
  assert.equal(passengerRating.json().ratee.averageRating, 4);
  assert.equal(passengerRating.json().ratee.ratingCount, 1);
  const updatedHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/history',
    headers: passengerHeaders,
  });
  assert.deepEqual(updatedHistory.json().rides.find(({ id }) => id === 'demo-ride-03').myRating, {
    stars: 4,
    comment: 'Trajet agréable et chauffeur ponctuel.',
    createdAt: passengerRating.json().rating.createdAt,
  });

  const duplicateRating = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-03/ratings',
    headers: passengerHeaders,
    payload: { stars: 5 },
  });
  assert.equal(duplicateRating.statusCode, 409);
  assert.equal(duplicateRating.json().error, 'RATING_ALREADY_SUBMITTED');

  const nonParticipantRating = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-03/ratings',
    headers: otherPassengerHeaders,
    payload: { stars: 5 },
  });
  assert.equal(nonParticipantRating.statusCode, 403);
  assert.equal(nonParticipantRating.json().error, 'RIDE_PARTICIPANT_REQUIRED');

  const nonCompletedRating = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/ratings',
    headers: otherPassengerHeaders,
    payload: { stars: 5 },
  });
  assert.equal(nonCompletedRating.statusCode, 409);
  assert.equal(nonCompletedRating.json().error, 'RIDE_NOT_COMPLETED');

  const invalidStars = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-03/ratings',
    headers: passengerHeaders,
    payload: { stars: 6 },
  });
  assert.equal(invalidStars.statusCode, 400);

  const driverRating = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-03/ratings',
    headers: driverHeaders,
    payload: { stars: 5 },
  });
  assert.equal(driverRating.statusCode, 201);
  assert.equal(driverRating.json().ratee.id, 'demo-passenger-01');
  assert.equal(driverRating.json().ratee.averageRating, 5);
  assert.equal(driverRating.json().ratee.ratingCount, 1);
});

test('an online driver can view compatible open ride requests', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers: { authorization: "Bearer " + login.json().token },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().rides.map(({ id, category, proposedPriceMGA, initialOfferId }) => ({
    id,
    category,
    proposedPriceMGA,
    initialOfferId,
  })), [{
    id: 'demo-ride-02',
    category: 'moto',
    proposedPriceMGA: 8000,
    initialOfferId: 'demo-offer-02',
  }]);
});

test('a driver can switch online and offline without account approval', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
  });
  const headers = { authorization: `Bearer ${login.json().token}` };

  const initialStatus = await app.inject({
    method: 'GET',
    url: '/api/driver/availability',
    headers,
  });
  assert.equal(initialStatus.statusCode, 200);
  assert.deepEqual(initialStatus.json(), {
    isOnline: true,
  });

  const offline = await app.inject({
    method: 'PATCH',
    url: '/api/driver/availability',
    headers,
    payload: { online: false },
  });
  assert.equal(offline.statusCode, 200);
  assert.deepEqual(offline.json(), { isOnline: false });
  const offlineStatus = await app.inject({
    method: 'GET',
    url: '/api/driver/availability',
    headers,
  });
  assert.equal(offlineStatus.json().isOnline, false);

  const unavailableRides = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers,
  });
  assert.equal(unavailableRides.statusCode, 403);
  assert.deepEqual(unavailableRides.json(), { error: 'DRIVER_NOT_AVAILABLE' });

  const online = await app.inject({
    method: 'PATCH',
    url: '/api/driver/availability',
    headers,
    payload: { online: true },
  });
  assert.equal(online.statusCode, 200);
  assert.deepEqual(online.json(), { isOnline: true });

  const availableRides = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers,
  });
  assert.equal(availableRides.statusCode, 200);
  assert.equal(availableRides.json().rides.length, 1);
});

test('a driver can submit a counter-offer to an open passenger request', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: "Bearer " + login.json().token },
    payload: { amountMGA: 3_000_000_000, respondsToOfferId: 'demo-offer-02' },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().offer.rideId, 'demo-ride-02');
  assert.equal(response.json().offer.proposerId, 'demo-driver-02');
  assert.equal(response.json().offer.amountMGA, 3_000_000_000);
  assert.equal(response.json().offer.respondsToOfferId, 'demo-offer-02');
  assert.equal(response.json().offer.status, 'pending');
});

test('a passenger can review and accept a driver offer to confirm a ride', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passengerLogin, driverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerAuthorization = "Bearer " + passengerLogin.json().token;
  const driverAuthorization = "Bearer " + driverLogin.json().token;
  const counterOffer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: driverAuthorization },
    payload: { amountMGA: 9000, respondsToOfferId: 'demo-offer-02' },
  });
  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: passengerAuthorization },
  });

  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(listResponse.json().offers.map(({ proposerId, amountMGA, status }) => ({
    proposerId,
    amountMGA,
    status,
  })), [
    { proposerId: 'demo-passenger-02', amountMGA: 8000, status: 'pending' },
    { proposerId: 'demo-driver-02', amountMGA: 9000, status: 'pending' },
  ]);
  const driverOffer = listResponse.json().offers.find(({ proposerId }) => proposerId === 'demo-driver-02');
  assert.deepEqual(driverOffer.proposer, {
    id: 'demo-driver-02',
    name: 'Fanja Andriam',
    photoUrl: null,
    averageRating: 0,
    ratingCount: 0,
    vehicleCategory: 'moto',
    vehicleMake: 'Honda',
    vehicleModel: 'Wave',
    vehicleColor: 'Noir',
  });
  assert.equal(Object.hasOwn(driverOffer.proposer, 'phone'), false);

  const unrelatedPassenger = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: {
      authorization: "Bearer " + (await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
      })).json().token,
    },
  });
  assert.equal(unrelatedPassenger.statusCode, 403);
  assert.deepEqual(unrelatedPassenger.json(), { error: 'RIDE_PARTICIPANT_REQUIRED' });

  const acceptResponse = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${counterOffer.json().offer.id}/accept`,
    headers: { authorization: passengerAuthorization },
  });

  assert.equal(acceptResponse.statusCode, 200);
  assert.equal(acceptResponse.json().ride.id, 'demo-ride-02');
  assert.equal(acceptResponse.json().ride.driverId, 'demo-driver-02');
  assert.equal(acceptResponse.json().ride.agreedPriceMGA, 9000);
  assert.equal(acceptResponse.json().ride.status, 'driver_en_route');
  const finalOffers = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: passengerAuthorization },
  });
  assert.equal(finalOffers.json().offers.find(({ id }) => id === counterOffer.json().offer.id).status, 'accepted');
  assert.equal(finalOffers.json().offers.find(({ proposerId }) => proposerId === 'demo-passenger-02').status, 'rejected');
});

test('a passenger can reject one driver offer without closing the ride', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passenger, driver] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerAuthorization = `Bearer ${passenger.json().token}`;
  const driverAuthorization = `Bearer ${driver.json().token}`;
  const offer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: driverAuthorization },
    payload: { amountMGA: 18000, respondsToOfferId: 'demo-offer-02' },
  });
  assert.equal(offer.statusCode, 201);

  const rejection = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${offer.json().offer.id}/reject`,
    headers: { authorization: passengerAuthorization },
  });
  assert.equal(rejection.statusCode, 200);
  assert.equal(rejection.json().offer.status, 'rejected');

  const offers = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: passengerAuthorization },
  });
  assert.equal(offers.statusCode, 200);
  assert.equal(offers.json().offers.find(({ id }) => id === offer.json().offer.id).status, 'rejected');
  assert.equal(offers.json().offers.find(({ id }) => id === 'demo-offer-02').status, 'pending');

  const nextOffer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: driverAuthorization },
    payload: { amountMGA: 17000, respondsToOfferId: 'demo-offer-02' },
  });
  assert.equal(nextOffer.statusCode, 201);
});

test('passenger and assigned driver can exchange messages on their confirmed ride', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passengerLogin, driverLogin, unrelatedPassengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const unrelatedHeaders = { authorization: `Bearer ${unrelatedPassengerLogin.json().token}` };
  const counterOffer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: driverHeaders,
    payload: { amountMGA: 9000, respondsToOfferId: 'demo-offer-02' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${counterOffer.json().offer.id}/accept`,
    headers: passengerHeaders,
  });

  const initialHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/messages',
    headers: driverHeaders,
  });
  assert.equal(initialHistory.statusCode, 200);
  assert.deepEqual(initialHistory.json(), { messages: [] });

  const sendMessage = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/messages',
    headers: passengerHeaders,
    payload: { body: 'Je vous attends à l’entrée principale.' },
  });
  assert.equal(sendMessage.statusCode, 201);
  assert.equal(sendMessage.json().message.rideId, 'demo-ride-02');
  assert.equal(sendMessage.json().message.senderId, 'demo-passenger-02');
  assert.equal(sendMessage.json().message.body, 'Je vous attends à l’entrée principale.');
  assert.deepEqual(sendMessage.json().message.sender, {
    id: 'demo-passenger-02',
    name: 'Hery Randria',
    photoUrl: null,
  });
  assert.equal('phone' in sendMessage.json().message.sender, false);
  const secondMessage = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/messages',
    headers: driverHeaders,
    payload: { body: 'Je suis en route.' },
  });
  assert.equal(secondMessage.statusCode, 201);

  const driverHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/messages',
    headers: driverHeaders,
  });
  assert.equal(driverHistory.statusCode, 200);
  assert.deepEqual(driverHistory.json().messages.map(({ body, sender }) => ({
    body,
    sender: sender.name,
  })), [
    { body: 'Je vous attends à l’entrée principale.', sender: 'Hery Randria' },
    { body: 'Je suis en route.', sender: 'Fanja Andriam' },
  ]);
  const activeRides = await app.inject({
    method: 'GET',
    url: '/api/driver/active-rides',
    headers: driverHeaders,
  });
  assert.equal(activeRides.statusCode, 200);
  assert.deepEqual(activeRides.json().rides.map(({ id, status, agreedPriceMGA }) => ({
    id,
    status,
    agreedPriceMGA,
  })), [{
    id: 'demo-ride-02',
    status: 'driver_en_route',
    agreedPriceMGA: 9000,
  }]);

  const forbiddenHistory = await app.inject({
    method: 'GET',
    url: '/api/rides/demo-ride-02/messages',
    headers: unrelatedHeaders,
  });
  assert.equal(forbiddenHistory.statusCode, 403);
  assert.deepEqual(forbiddenHistory.json(), { error: 'RIDE_PARTICIPANT_REQUIRED' });

  const blankMessage = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/messages',
    headers: passengerHeaders,
    payload: { body: '   ' },
  });
  assert.equal(blankMessage.statusCode, 400);
  const longMessage = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/messages',
    headers: passengerHeaders,
    payload: { body: 'x'.repeat(2001) },
  });
  assert.equal(longMessage.statusCode, 400);
});

test('an assigned driver advances a ride through its allowed statuses', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passengerLogin, driverLogin, otherDriverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const otherDriverHeaders = { authorization: `Bearer ${otherDriverLogin.json().token}` };
  const offer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: driverHeaders,
    payload: { amountMGA: 9000, respondsToOfferId: 'demo-offer-02' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${offer.json().offer.id}/accept`,
    headers: passengerHeaders,
  });

  const arrived = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: driverHeaders,
    payload: { status: 'driver_arrived' },
  });
  assert.equal(arrived.statusCode, 200);
  assert.equal(arrived.json().ride.status, 'driver_arrived');

  const started = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: driverHeaders,
    payload: { status: 'in_progress' },
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().ride.status, 'in_progress');

  const completed = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: driverHeaders,
    payload: { status: 'completed' },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().ride.status, 'completed');
  assert.ok(completed.json().ride.completedAt);

  const passengerCancellationAfterStart = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/cancel',
    headers: passengerHeaders,
  });
  assert.equal(passengerCancellationAfterStart.statusCode, 409);
  assert.deepEqual(passengerCancellationAfterStart.json(), { error: 'RIDE_CANNOT_BE_CANCELLED' });

  const driverStats = await app.inject({
    method: 'GET',
    url: '/api/driver/active-rides',
    headers: driverHeaders,
  });
  assert.deepEqual(driverStats.json().stats, {
    completedToday: 1,
    completedThisWeek: 1,
  });

  const completedLocation = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/location',
    headers: driverHeaders,
    payload: { latitude: -18.91, longitude: 47.52 },
  });
  assert.equal(completedLocation.statusCode, 409);
  assert.equal(completedLocation.json().error, 'RIDE_LOCATION_NOT_ACTIVE');

  const illegalTransition = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: driverHeaders,
    payload: { status: 'in_progress' },
  });
  assert.equal(illegalTransition.statusCode, 409);
  assert.equal(illegalTransition.json().error, 'RIDE_STATUS_TRANSITION_INVALID');

  const wrongDriver = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: otherDriverHeaders,
    payload: { status: 'driver_arrived' },
  });
  assert.equal(wrongDriver.statusCode, 403);
  assert.deepEqual(wrongDriver.json(), { error: 'RIDE_PARTICIPANT_REQUIRED' });
});

test('only the assigned driver can update a location during an active ride', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const [passengerLogin, driverLogin, otherDriverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const otherDriverHeaders = { authorization: `Bearer ${otherDriverLogin.json().token}` };
  const offer = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: driverHeaders,
    payload: { amountMGA: 9000, respondsToOfferId: 'demo-offer-02' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${offer.json().offer.id}/accept`,
    headers: passengerHeaders,
  });

  const position = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/location',
    headers: driverHeaders,
    payload: { latitude: -18.91, longitude: 47.52 },
  });
  assert.equal(position.statusCode, 200);
  assert.equal(position.json().location.rideId, 'demo-ride-02');
  assert.equal(position.json().location.latitude, -18.91);
  assert.equal(position.json().location.longitude, 47.52);
  assert.ok(position.json().location.updatedAt);

  const wrongDriver = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/location',
    headers: otherDriverHeaders,
    payload: { latitude: -18.91, longitude: 47.52 },
  });
  assert.equal(wrongDriver.statusCode, 403);
  assert.deepEqual(wrongDriver.json(), { error: 'RIDE_PARTICIPANT_REQUIRED' });

  const invalidLocation = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/location',
    headers: driverHeaders,
    payload: { latitude: -91, longitude: 47.52 },
  });
  assert.equal(invalidLocation.statusCode, 400);
});

test('a signed-in passenger can request a short-lived real-time ticket', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  const authorization = `Bearer ${login.json().token}`;

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/realtime/ticket',
  });
  assert.equal(unauthorized.statusCode, 401);

  const ticketResponse = await app.inject({
    method: 'POST',
    url: '/api/realtime/ticket',
    headers: { authorization },
  });
  assert.equal(ticketResponse.statusCode, 201);
  assert.match(ticketResponse.json().ticket, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(ticketResponse.json().expiresInSeconds, 30);
});

test('a ride participant receives offer changes on the authenticated WebSocket', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await app.close();
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const [passengerLogin, driverLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
  ]);
  const passengerAuthorization = `Bearer ${passengerLogin.json().token}`;
  const driverAuthorization = `Bearer ${driverLogin.json().token}`;
  const ticketResponse = await app.inject({
    method: 'POST',
    url: '/api/realtime/ticket',
    headers: { authorization: passengerAuthorization },
  });
  const socket = await new Promise((resolve, reject) => {
    const connection = new WebSocket(
      `${address.replace('http:', 'ws:')}/api/realtime?ticket=${encodeURIComponent(ticketResponse.json().ticket)}`,
    );
    sockets.add(connection);
    connection.addEventListener('open', () => resolve(connection), { once: true });
    connection.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  const driverTicket = await app.inject({
    method: 'POST',
    url: '/api/realtime/ticket',
    headers: { authorization: driverAuthorization },
  });
  const driverSocket = await new Promise((resolve, reject) => {
    const connection = new WebSocket(
      `${address.replace('http:', 'ws:')}/api/realtime?ticket=${encodeURIComponent(driverTicket.json().ticket)}`,
    );
    sockets.add(connection);
    connection.addEventListener('open', () => resolve(connection), { once: true });
    connection.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  const nextDriverMessage = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for driver WebSocket message')), 1500);
    driverSocket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  const nextMessage = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 1500);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  const nextMessages = (count) => new Promise((resolve, reject) => {
    const messages = [];
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket messages')), 1500);
    const handleMessage = (event) => {
      messages.push(JSON.parse(event.data));
      if (messages.length !== count) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', handleMessage);
      resolve(messages);
    };
    socket.addEventListener('message', handleMessage);
  });

  const subscribed = nextMessage();
  socket.send(JSON.stringify({ type: 'subscribe', rideId: 'demo-ride-02' }));
  assert.deepEqual(await subscribed, { type: 'subscribed', rideId: 'demo-ride-02' });
  const driverSubscribed = nextDriverMessage();
  driverSocket.send(JSON.stringify({ type: 'subscribe', rideId: 'demo-ride-02' }));
  assert.deepEqual(await driverSubscribed, { type: 'subscribed', rideId: 'demo-ride-02' });

  const forbiddenSubscription = nextMessage();
  socket.send(JSON.stringify({ type: 'subscribe', rideId: 'demo-ride-03' }));
  assert.deepEqual(await forbiddenSubscription, {
    type: 'error',
    rideId: 'demo-ride-03',
    error: 'RIDE_PARTICIPANT_REQUIRED',
  });

  const offerEvent = nextMessage();
  const driverOfferEvent = nextDriverMessage();
  const offerResponse = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: driverAuthorization },
    payload: { amountMGA: 9000, respondsToOfferId: 'demo-offer-02' },
  });
  assert.equal(offerResponse.statusCode, 201);
  assert.deepEqual(await offerEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });
  assert.deepEqual(await driverOfferEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });

  const passengerRejectionEvent = nextMessage();
  const driverRejectionEvent = nextDriverMessage();
  const rejection = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${offerResponse.json().offer.id}/reject`,
    headers: { authorization: passengerAuthorization },
  });
  assert.equal(rejection.statusCode, 200);
  assert.deepEqual(await passengerRejectionEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });
  assert.deepEqual(await driverRejectionEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });

  const nextOfferEvent = nextMessage();
  const nextDriverOfferEvent = nextDriverMessage();
  const acceptedOfferResponse = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/offers',
    headers: { authorization: driverAuthorization },
    payload: { amountMGA: 8500, respondsToOfferId: 'demo-offer-02' },
  });
  assert.equal(acceptedOfferResponse.statusCode, 201);
  assert.deepEqual(await nextOfferEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });
  assert.deepEqual(await nextDriverOfferEvent, { type: 'offers.updated', rideId: 'demo-ride-02' });

  const rideEvent = nextMessage();
  const driverRideEvent = nextDriverMessage();
  const acceptance = await app.inject({
    method: 'POST',
    url: `/api/rides/demo-ride-02/offers/${acceptedOfferResponse.json().offer.id}/accept`,
    headers: { authorization: passengerAuthorization },
  });
  assert.equal(acceptance.statusCode, 200);
  assert.deepEqual(await rideEvent, {
    type: 'ride.updated',
    rideId: 'demo-ride-02',
    status: 'driver_en_route',
  });
  assert.deepEqual(await driverRideEvent, {
    type: 'ride.updated',
    rideId: 'demo-ride-02',
    status: 'driver_en_route',
  });
  const chatEvent = nextDriverMessage();
  const passengerChatEvent = nextMessage();
  const sentMessage = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/messages',
    headers: { authorization: passengerAuthorization },
    payload: { body: 'Message en direct.' },
  });
  assert.equal(sentMessage.statusCode, 201);
  const expectedChatEvent = {
    type: 'message.created',
    rideId: 'demo-ride-02',
    message: sentMessage.json().message,
  };
  assert.deepEqual(await chatEvent, expectedChatEvent);
  assert.deepEqual(await passengerChatEvent, expectedChatEvent);
  const passengerLocationEvent = nextMessage();
  const driverLocationEvent = nextDriverMessage();
  const driverLocation = await app.inject({
    method: 'POST',
    url: '/api/rides/demo-ride-02/location',
    headers: { authorization: driverAuthorization },
    payload: { latitude: -18.91, longitude: 47.52 },
  });
  assert.equal(driverLocation.statusCode, 200);
  const expectedLocationEvent = {
    type: 'ride.location.updated',
    rideId: 'demo-ride-02',
    location: {
      latitude: -18.91,
      longitude: 47.52,
      updatedAt: driverLocation.json().location.updatedAt,
    },
  };
  assert.deepEqual(await passengerLocationEvent, expectedLocationEvent);
  assert.deepEqual(await driverLocationEvent, expectedLocationEvent);
  const subscriptionMessages = nextMessages(2);
  socket.send(JSON.stringify({ type: 'subscribe', rideId: 'demo-ride-02' }));
  const [resubscribed, restoredLocation] = await subscriptionMessages;
  assert.deepEqual(resubscribed, { type: 'subscribed', rideId: 'demo-ride-02' });
  assert.deepEqual(restoredLocation, expectedLocationEvent);
  const passengerStatusEvent = nextMessage();
  const driverStatusEvent = nextDriverMessage();
  const rideStatus = await app.inject({
    method: 'PATCH',
    url: '/api/rides/demo-ride-02/status',
    headers: { authorization: driverAuthorization },
    payload: { status: 'driver_arrived' },
  });
  assert.equal(rideStatus.statusCode, 200);
  const expectedStatusEvent = {
    type: 'ride.updated',
    rideId: 'demo-ride-02',
    status: 'driver_arrived',
  };
  assert.deepEqual(await passengerStatusEvent, expectedStatusEvent);
  assert.deepEqual(await driverStatusEvent, expectedStatusEvent);

  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  socket.close();
  await closed;
  const reusedTicketResult = await new Promise((resolve) => {
    const reusedSocket = new WebSocket(
      `${address.replace('http:', 'ws:')}/api/realtime?ticket=${encodeURIComponent(ticketResponse.json().ticket)}`,
    );
    sockets.add(reusedSocket);
    const timeout = setTimeout(() => resolve('timeout'), 1500);
    reusedSocket.addEventListener('open', () => {
      clearTimeout(timeout);
      reusedSocket.close();
      resolve('accepted');
    }, { once: true });
    reusedSocket.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve('rejected');
    }, { once: true });
  });
  assert.equal(reusedTicketResult, 'rejected');
});

test('new ride requests are pushed immediately to online compatible drivers', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await app.close();
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const [driverLogin, passengerLogin] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Fanja Andriam', password: 'DriveNight2026!' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
    }),
  ]);
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };
  const passengerHeaders = { authorization: `Bearer ${passengerLogin.json().token}` };
  const ticket = await app.inject({
    method: 'POST',
    url: '/api/realtime/ticket',
    headers: driverHeaders,
  });
  socket = await new Promise((resolve, reject) => {
    const connection = new WebSocket(
      `${address.replace('http:', 'ws:')}/api/realtime?ticket=${encodeURIComponent(ticket.json().ticket)}`,
    );
    connection.addEventListener('open', () => resolve(connection), { once: true });
    connection.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  const availableRide = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for available ride event')), 1500);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  const newRide = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers: passengerHeaders,
    payload: {
      origin: { label: 'Analakely', latitude: -18.9087, longitude: 47.526 },
      destination: { label: 'Ivandry', latitude: -18.8765, longitude: 47.5355 },
      category: 'moto',
      proposedPriceMGA: 7000,
    },
  });

  assert.equal(newRide.statusCode, 201);
  assert.deepEqual(await availableRide, {
    type: 'ride.available',
    rideId: newRide.json().ride.id,
  });
});

test('address lookup uses Antananarivo search results and caches repeat queries', async (t) => {
  let upstreamCalls = 0;
  const upstreamRequestTimes = [];
  let upstreamUrl;
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    fetchImpl: async (url, options) => {
      upstreamCalls += 1;
      upstreamRequestTimes.push(Date.now());
      upstreamUrl = new URL(url);
      assert.equal(options.headers['User-Agent'], 'DriveNight local address lookup');
      assert.equal(options.headers['Accept-Language'], 'fr');
      return {
        ok: true,
        json: async () => [{
          place_id: 123,
          display_name: 'Analakely, Antananarivo, Madagascar',
          lat: '-18.9087',
          lon: '47.526',
        }],
      };
    },
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  const headers = { authorization: 'Bearer ' + login.json().token };
  const firstSearch = await app.inject({
    method: 'GET',
    url: '/api/places/search?q=Analakely',
    headers,
  });
  const cachedSearch = await app.inject({
    method: 'GET',
    url: '/api/places/search?q=Analakely',
    headers,
  });

  assert.equal(firstSearch.statusCode, 200);
  assert.deepEqual(firstSearch.json(), {
    places: [{
      id: '123',
      label: 'Analakely, Antananarivo, Madagascar',
      latitude: -18.9087,
      longitude: 47.526,
    }],
  });
  assert.deepEqual(cachedSearch.json(), firstSearch.json());
  assert.equal(upstreamCalls, 1);
  assert.equal(upstreamUrl.searchParams.get('countrycodes'), 'mg');
  assert.equal(upstreamUrl.searchParams.get('bounded'), '1');

  const nextSearch = await app.inject({
    method: 'GET',
    url: '/api/places/search?q=Ivandry',
    headers,
  });
  assert.equal(nextSearch.statusCode, 200);
  assert.equal(upstreamCalls, 2);
  assert.ok(upstreamRequestTimes[1] - upstreamRequestTimes[0] >= 950);
});

test('a map-selected point can be labelled by reverse address lookup', async (t) => {
  let upstreamUrl;
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    fetchImpl: async (url) => {
      upstreamUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({ display_name: 'Analakely, Antananarivo, Madagascar' }),
      };
    },
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  const lookup = await app.inject({
    method: 'GET',
    url: '/api/places/reverse?latitude=-18.9087&longitude=47.526',
    headers: { authorization: 'Bearer ' + login.json().token },
  });

  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.json().label, 'Analakely, Antananarivo, Madagascar');
  assert.equal(upstreamUrl.pathname, '/reverse');
  assert.equal(upstreamUrl.searchParams.get('lat'), '-18.9087');
  assert.equal(upstreamUrl.searchParams.get('lon'), '47.526');
});

test('a new account is created only after its email confirmation code is verified', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const challenge = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'Lova@Example.Test',
      phone: '0340000098',
      role: 'driver',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
      vehicleCategory: 'moto',
      vehicleRegistration: '1234 TAA',
    },
  });
  const { challengeId, otp } = challenge.json();

  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: { challengeId, otp },
  });

  assert.equal(registration.statusCode, 200);
  assert.equal(registration.json().user.phone, '+261340000098');
  assert.equal(registration.json().user.role, 'driver');
  assert.equal(registration.json().user.name, 'Lova R.');
  assert.equal(registration.json().user.email, 'lova@example.test');
  assert.equal(registration.json().user.emailVerified, true);
  assert.equal(registration.json().user.termsVersion, '2026-11-05');
  assert.match(registration.json().user.termsAcceptedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(registration.json().user.vehicleCategory, 'moto');
  assert.equal(registration.json().user.vehicleRegistration, '1234 TAA');

  const emailLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'lova@example.test', password: 'StrongPass2026!' },
  });
  assert.equal(emailLogin.statusCode, 200);
  assert.equal(emailLogin.json().user.emailVerified, true);

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Lova R.', password: 'WrongPassword2026!' },
  });
  assert.equal(wrongPassword.statusCode, 401);

  const reusedChallenge = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: { challengeId, otp, name: 'Lova R.' },
  });
  assert.equal(reusedChallenge.statusCode, 400);

  const unauthorizedProfile = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(unauthorizedProfile.statusCode, 401);
});

test('a driver can register a profile photo and vehicle details', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-profile-'));
  const app = await createApp({
    databasePath: ':memory:',
    uploadsDirectory: join(directory, 'photos'),
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const incompleteDriver = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'incomplete-driver@example.test',
      phone: '+261340000078',
      role: 'driver',
      name: 'Mamy Driver',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });
  assert.equal(incompleteDriver.statusCode, 400);
  assert.deepEqual(incompleteDriver.json(), { error: 'DRIVER_VEHICLE_REQUIRED' });

  const challenge = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'driver@example.test',
      phone: '+261340000077',
      role: 'driver',
      name: 'Mamy Driver',
      password: 'StrongPass2026!',
      termsAccepted: true,
      vehicleCategory: 'voiture',
      vehicleRegistration: '1234 TAA',
      profilePhoto: 'data:image/jpeg;base64,/9j/2Q==',
    },
  });
  assert.equal(challenge.statusCode, 200);

  const { challengeId, otp } = challenge.json();
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: { challengeId, otp },
  });

  assert.equal(registration.statusCode, 200);
  const driver = registration.json().user;
  assert.equal(driver.vehicleCategory, 'voiture');
  assert.equal(driver.vehicleRegistration, '1234 TAA');
  assert.match(driver.photoUrl, /^\/api\/media\/[0-9a-f-]+\.jpg$/);

  const driverStatus = await app.inject({
    method: 'GET',
    url: '/api/driver/availability',
    headers: { authorization: `Bearer ${registration.json().token}` },
  });
  assert.equal(driverStatus.statusCode, 200);
  assert.deepEqual(driverStatus.json(), {
    isOnline: false,
  });
  const canGoOnlineImmediately = await app.inject({
    method: 'PATCH',
    url: '/api/driver/availability',
    headers: { authorization: 'Bearer ' + registration.json().token },
    payload: { online: true },
  });
  assert.equal(canGoOnlineImmediately.statusCode, 200);
  assert.deepEqual(canGoOnlineImmediately.json(), { isOnline: true });

  const photo = await app.inject({ method: 'GET', url: driver.photoUrl });
  assert.equal(photo.statusCode, 200);
  assert.match(photo.headers['content-type'], /^image\/jpeg/);
  assert.deepEqual(photo.rawPayload, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const profile = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${registration.json().token}` },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().vehicleRegistration, '1234 TAA');
  assert.equal(profile.json().photoUrl, driver.photoUrl);
});

test('signup rejects an invalid email before issuing a confirmation code', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'not-an-email',
      phone: '+261340000098',
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'EMAIL_INVALID' });
});

test('signup cannot proceed without accepting the terms of use and privacy policy', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'lova@example.test',
      phone: '+261340000098',
      role: 'driver',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: false,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'TERMS_NOT_ACCEPTED' });
});

test('production email verification sends a code without returning it to the client', async (t) => {
  const sentEmails = [];
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async (message) => sentEmails.push(message),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'lova@example.test',
      phone: '+261340000098',
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().delivery, 'email');
  assert.equal('otp' in response.json(), false);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'lova@example.test');
  assert.match(sentEmails[0].code, /^\d{6}$/);

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: response.json().challengeId,
      otp: sentEmails[0].code,
    },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().user.email, 'lova@example.test');
  const reused = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: response.json().challengeId,
      otp: sentEmails[0].code,
    },
  });
  assert.equal(reused.statusCode, 400);
  assert.deepEqual(reused.json(), { error: 'OTP_EXPIRED_OR_INVALID' });
});

test('production email verification fails clearly when the provider is not configured', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'lova@example.test',
      phone: '+261340000098',
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
});

test('a pending production email challenge survives an API restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drivenight-email-challenge-'));
  const databasePath = join(directory, 'test.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentEmails = [];
  const options = {
    databasePath,
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async (message) => sentEmails.push(message),
  };
  const firstApp = await createApp(options);
  const response = await firstApp.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'persisted@example.test',
      phone: '+261340000097',
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });
  assert.equal(response.statusCode, 200);
  await firstApp.close();

  const secondApp = await createApp(options);
  t.after(() => secondApp.close());
  const verification = await secondApp.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: response.json().challengeId,
      otp: sentEmails[0].code,
    },
  });

  assert.equal(verification.statusCode, 200);
  assert.equal(verification.json().user.email, 'persisted@example.test');
});

test('production email changes use the same private one-time email verification flow', async (t) => {
  const sentEmails = [];
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async (message) => sentEmails.push(message),
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  const headers = { authorization: `Bearer ${login.json().token}` };
  const requested = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/request',
    headers,
    payload: { email: 'miora-new@example.test' },
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.json().delivery, 'email');
  assert.equal('otp' in requested.json(), false);
  assert.equal(sentEmails[0].purpose, 'email-change');

  const verified = await app.inject({
    method: 'POST',
    url: '/api/account/profile/email/verify',
    headers,
    payload: { challengeId: requested.json().challengeId, otp: sentEmails[0].code },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().profile.email, 'miora-new@example.test');
  assert.equal(verified.json().profile.emailVerified, true);
});

test('a production email code cannot create two accounts when verified concurrently', async (t) => {
  const sentEmails = [];
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async (message) => sentEmails.push(message),
  });
  t.after(() => app.close());

  const requested = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'once@example.test',
      phone: '+261340000096',
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });
  assert.equal(requested.statusCode, 200);

  const verify = () => app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: requested.json().challengeId,
      otp: sentEmails[0].code,
    },
  });
  const results = await Promise.all([verify(), verify()]);

  assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [200, 400]);
});

test('email codes expire after five minutes and stop after five incorrect attempts', async (t) => {
  let now = Date.now();
  const sentEmails = [];
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async (message) => sentEmails.push(message),
    clock: () => now,
  });
  t.after(() => app.close());

  const requestOtp = (email, phone) => app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email,
      phone,
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });
  const limited = await requestOtp('attempts@example.test', '+261340000095');
  assert.equal(limited.statusCode, 200);
  const wrongCode = sentEmails[0].code === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        challengeId: limited.json().challengeId,
        otp: wrongCode,
      },
    });
    assert.equal(invalid.statusCode, 400);
  }
  const exhausted = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: limited.json().challengeId,
      otp: sentEmails[0].code,
    },
  });
  assert.equal(exhausted.statusCode, 400);

  const expiring = await requestOtp('expires@example.test', '+261340000094');
  assert.equal(expiring.statusCode, 200);
  now += 5 * 60 * 1000 + 1;
  const expired = await app.inject({
    method: 'POST',
    url: '/api/auth/otp/verify',
    payload: {
      challengeId: expiring.json().challengeId,
      otp: sentEmails[1].code,
    },
  });
  assert.equal(expired.statusCode, 400);
});

test('email verification limits code sends per recipient', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    environment: 'production',
    emailDeliveryEnabled: true,
    emailSender: async () => {},
  });
  t.after(() => app.close());

  const requestOtp = (phone) => app.inject({
    method: 'POST',
    url: '/api/auth/otp/request',
    payload: {
      flow: 'signup',
      email: 'limited@example.test',
      phone,
      role: 'passenger',
      name: 'Lova R.',
      password: 'StrongPass2026!',
      termsAccepted: true,
    },
  });
  for (const phone of [
    '+261340000091',
    '+261340000092',
    '+261340000093',
  ]) {
    assert.equal((await requestOtp(phone)).statusCode, 200);
  }
  const limited = await requestOtp('+261340000094');
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { error: 'EMAIL_RATE_LIMITED' });
});
