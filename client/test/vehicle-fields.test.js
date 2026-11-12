import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeVehicleDetails,
  vehicleSignupMetadata,
  vehicleSummary,
} from '../src/lib/vehicle-fields.js';

test('a moto only needs a colour and never keeps a registration number', () => {
  const result = normalizeVehicleDetails({
    category: 'moto',
    color: '  Rouge ',
    make: '',
    registration: '1234 TAA',
  });

  assert.deepEqual(result, {
    ok: true,
    vehicle: { category: 'moto', color: 'Rouge', make: null, registration: null },
  });
});

test('a moto without colour is refused', () => {
  assert.deepEqual(
    normalizeVehicleDetails({ category: 'moto', color: '  ', make: '', registration: '' }),
    { ok: false, error: 'DRIVER_VEHICLE_REQUIRED', field: 'color' },
  );
});

test('a car needs registration, colour and make', () => {
  assert.deepEqual(
    normalizeVehicleDetails({ category: 'voiture', color: 'Blanche', make: 'Toyota', registration: ' 1234 TAA ' }),
    {
      ok: true,
      vehicle: { category: 'voiture', color: 'Blanche', make: 'Toyota', registration: '1234 TAA' },
    },
  );
  assert.equal(
    normalizeVehicleDetails({ category: 'voiture', color: 'Blanche', make: 'Toyota', registration: '' }).field,
    'registration',
  );
  assert.equal(
    normalizeVehicleDetails({ category: 'voiture', color: '', make: 'Toyota', registration: '1234 TAA' }).field,
    'color',
  );
  assert.equal(
    normalizeVehicleDetails({ category: 'voiture', color: 'Blanche', make: '', registration: '1234 TAA' }).field,
    'make',
  );
});

test('a car registration must stay between 3 and 20 characters', () => {
  assert.equal(
    normalizeVehicleDetails({ category: 'voiture', color: 'Noire', make: 'Kia', registration: 'AB' }).field,
    'registration',
  );
  assert.equal(
    normalizeVehicleDetails({ category: 'voiture', color: 'Noire', make: 'Kia', registration: 'A'.repeat(21) }).field,
    'registration',
  );
});

test('vehicleSignupMetadata sends only the fields that apply to the category', () => {
  assert.deepEqual(
    vehicleSignupMetadata({ category: 'moto', color: 'Bleue', make: '', registration: '' }),
    { vehicle_category: 'moto', vehicle_color: 'Bleue' },
  );
  assert.deepEqual(
    vehicleSignupMetadata({ category: 'voiture', color: 'Grise', make: 'Renault', registration: '5678 TBB' }),
    {
      vehicle_category: 'voiture',
      vehicle_color: 'Grise',
      vehicle_make: 'Renault',
      vehicle_registration: '5678 TBB',
    },
  );
});

test('vehicleSummary joins the known details in a readable line', () => {
  assert.equal(vehicleSummary({ category: 'moto', color: 'Rouge' }), 'Moto · Rouge');
  assert.equal(
    vehicleSummary({ category: 'voiture', make: 'Toyota', color: 'Blanche', registration: '1234 TAA' }),
    'Voiture · Toyota · Blanche · 1234 TAA',
  );
  assert.equal(vehicleSummary(null), '');
});
