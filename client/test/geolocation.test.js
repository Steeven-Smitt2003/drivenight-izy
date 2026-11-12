import assert from 'node:assert/strict';
import test from 'node:test';
import {
  geolocationErrorMessage,
  requestCurrentPosition,
} from '../src/lib/geolocation.js';

test('requestCurrentPosition resolves latitude, longitude, and accuracy from browser geolocation', async () => {
  const fakeGeolocation = {
    getCurrentPosition(onSuccess) {
      onSuccess({
        coords: {
          latitude: -18.9079,
          longitude: 47.5256,
          accuracy: 18,
        },
      });
    },
  };

  const position = await requestCurrentPosition(fakeGeolocation);

  assert.deepEqual(position, {
    latitude: -18.9079,
    longitude: 47.5256,
    accuracy: 18,
  });
});

test('requestCurrentPosition retries without high accuracy when high accuracy times out', async () => {
  const calls = [];
  const fakeGeolocation = {
    getCurrentPosition(onSuccess, onError, options) {
      calls.push(options);
      if (options.enableHighAccuracy) {
        onError({ code: 3, TIMEOUT: 3, message: 'Timeout expired' });
        return;
      }
      onSuccess({
        coords: {
          latitude: -18.9137,
          longitude: 47.5363,
          accuracy: 65,
        },
      });
    },
  };

  const position = await requestCurrentPosition(fakeGeolocation);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].enableHighAccuracy, true);
  assert.equal(calls[1].enableHighAccuracy, false);
  assert.equal(position.latitude, -18.9137);
  assert.equal(position.longitude, 47.5363);
});

test('requestCurrentPosition rejects with GEOLOCATION_UNSUPPORTED when geolocation API is missing', async () => {
  await assert.rejects(
    () => requestCurrentPosition(null),
    (error) => {
      assert.equal(error.code, 'GEOLOCATION_UNSUPPORTED');
      assert.match(geolocationErrorMessage(error), /géolocalisation n’est pas disponible/i);
      return true;
    },
  );
});

test('geolocationErrorMessage returns clear French messages for permission denied and timeout', () => {
  assert.match(
    geolocationErrorMessage({ code: 1 }),
    /Autorisez l’accès à votre position/i,
  );
  assert.match(
    geolocationErrorMessage({ code: 2 }),
    /position GPS est actuellement indisponible/i,
  );
  assert.match(
    geolocationErrorMessage({ code: 3 }),
    /localisation a pris trop de temps/i,
  );
});
