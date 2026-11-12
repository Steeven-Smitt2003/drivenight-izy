import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTravelMinutes,
  fetchRoadEta,
  formatDistance,
  formatEta,
  haversineKm,
} from '../src/lib/eta.js';

test('haversineKm measures about one kilometre for 0.01 degree of longitude at Antananarivo', () => {
  const km = haversineKm(
    { latitude: -18.9137, longitude: 47.5363 },
    { latitude: -18.9137, longitude: 47.5463 },
  );
  assert.ok(Math.abs(km - 1.05) < 0.03, `distance inattendue : ${km}`);
});

test('estimateTravelMinutes uses a road factor and a slower car speed than moto', () => {
  assert.equal(estimateTravelMinutes({ distanceKm: 5, category: 'moto' }), 14);
  assert.equal(estimateTravelMinutes({ distanceKm: 5, category: 'voiture' }), 18);
  assert.equal(estimateTravelMinutes({ distanceKm: 0, category: 'moto' }), 1);
});

test('formatEta writes short French durations', () => {
  assert.equal(formatEta(0.4), 'moins d’1 min');
  assert.equal(formatEta(1), '1 min');
  assert.equal(formatEta(12), '12 min');
  assert.equal(formatEta(65), '1 h 05');
  assert.equal(formatEta(120), '2 h 00');
});

test('formatDistance switches from metres to kilometres', () => {
  assert.equal(formatDistance(0.45), '450 m');
  assert.equal(formatDistance(1.234), '1,2 km');
  assert.equal(formatDistance(12.04), '12 km');
});

test('fetchRoadEta reads the road duration and sends longitude first to the router', async () => {
  let requestedUrl = '';
  const eta = await fetchRoadEta(
    { latitude: -18.9, longitude: 47.5 },
    { latitude: -18.8, longitude: 47.6 },
    {
      category: 'moto',
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ code: 'Ok', routes: [{ duration: 600.4, distance: 4200 }] }),
        };
      },
    },
  );

  assert.ok(requestedUrl.includes('/route/v1/driving/47.5,-18.9;47.6,-18.8'));
  assert.deepEqual(eta, { minutes: 10, distanceKm: 4.2, source: 'route' });
});

test('fetchRoadEta falls back to the straight-line estimate when the router fails', async () => {
  const eta = await fetchRoadEta(
    { latitude: -18.9137, longitude: 47.5363 },
    { latitude: -18.9137, longitude: 47.5463 },
    {
      category: 'voiture',
      fetchImpl: async () => { throw new Error('network'); },
    },
  );

  assert.equal(eta.source, 'estimate');
  assert.ok(eta.minutes >= 1);
  assert.ok(Math.abs(eta.distanceKm - 1.05) < 0.03);
});
