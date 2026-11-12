import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('admin can delete an account and cannot delete self', async (t) => {
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
  });
  t.after(() => app.close());

  // 1. Sign in as default admin
  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Admin DriveNight', password: 'DriveNight2026!' },
  });
  assert.equal(adminLogin.statusCode, 200);
  const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

  // 2. Admin cannot delete themselves
  const selfDelete = await app.inject({
    method: 'DELETE',
    url: `/api/admin/accounts/${adminLogin.json().user.id}`,
    headers: adminHeaders,
  });
  assert.equal(selfDelete.statusCode, 400);
  assert.equal(selfDelete.json().error, 'CANNOT_DELETE_SELF');

  // 3. Admin can create a new passenger account or use seeded passenger
  const passengerLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  assert.equal(passengerLogin.statusCode, 200);
  const passengerId = passengerLogin.json().user.id;

  // 4. Admin deletes passenger account
  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/api/admin/accounts/${passengerId}`,
    headers: adminHeaders,
  });
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(deleteRes.json().success, true);

  // 5. Deleted user can no longer sign in
  const retryLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Miora Rakoto', password: 'DriveNight2026!' },
  });
  assert.equal(retryLogin.statusCode, 401);
});

test('searching ride older than 30 minutes with no offers expires automatically', async (t) => {
  let simulatedTime = Date.now();
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    jwtSecret: 'test-secret-with-more-than-32-characters',
    clock: () => simulatedTime,
  });
  t.after(() => app.close());

  const passengerLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Hery Randria', password: 'DriveNight2026!' },
  });
  assert.equal(passengerLogin.statusCode, 200);
  const headers = { authorization: `Bearer ${passengerLogin.json().token}` };

  // Create ride
  const rideRes = await app.inject({
    method: 'POST',
    url: '/api/rides',
    headers,
    payload: {
      origin: { label: 'Point A', latitude: -18.9, longitude: 47.5 },
      destination: { label: 'Point B', latitude: -18.91, longitude: 47.51 },
      category: 'moto',
      proposedPriceMGA: 5000,
    },
  });
  assert.equal(rideRes.statusCode, 201);
  const rideId = rideRes.json().ride.id;

  // Advance time by 31 minutes
  simulatedTime += 31 * 60 * 1000;

  // Query driver rides or active rides which triggers expireTimedOffers()
  const driverLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'Tiana Rasoanaivo', password: 'DriveNight2026!' },
  });
  const driverHeaders = { authorization: `Bearer ${driverLogin.json().token}` };

  const driverRides = await app.inject({
    method: 'GET',
    url: '/api/driver/rides',
    headers: driverHeaders,
  });
  assert.equal(driverRides.statusCode, 200);
  assert.ok(!driverRides.json().rides.some((r) => r.id === rideId));

  // Check offers route or check active driver rides
  const offersRes = await app.inject({
    method: 'GET',
    url: `/api/rides/${rideId}/offers`,
    headers,
  });
  assert.equal(offersRes.statusCode, 200);
});
