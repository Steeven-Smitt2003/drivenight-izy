import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectCityFromCoordinates,
  extractCityFromNominatim,
  resolveCityName,
} from '../src/lib/city-detection.js';

test('detectCityFromCoordinates identifies Antsiranana from northern Madagascar coordinates', () => {
  assert.equal(detectCityFromCoordinates(-12.28, 49.29), 'Antsiranana');
  assert.equal(detectCityFromCoordinates(-12.35, 49.30), 'Antsiranana');
});

test('detectCityFromCoordinates identifies Antananarivo from capital coordinates', () => {
  assert.equal(detectCityFromCoordinates(-18.9137, 47.5363), 'Antananarivo');
  assert.equal(detectCityFromCoordinates(-18.87, 47.51), 'Antananarivo');
});

test('detectCityFromCoordinates identifies other major cities', () => {
  assert.equal(detectCityFromCoordinates(-15.71, 46.32), 'Mahajanga');
  assert.equal(detectCityFromCoordinates(-18.15, 49.40), 'Toamasina');
  assert.equal(detectCityFromCoordinates(-19.86, 47.03), 'Antsirabe');
  assert.equal(detectCityFromCoordinates(-21.45, 47.08), 'Fianarantsoa');
  assert.equal(detectCityFromCoordinates(-23.35, 43.67), 'Toliara');
  assert.equal(detectCityFromCoordinates(-13.30, 48.25), 'Nosy Be');
});

test('detectCityFromCoordinates defaults to Antananarivo for unknown or missing coordinates', () => {
  assert.equal(detectCityFromCoordinates(null, null), 'Antananarivo');
  assert.equal(detectCityFromCoordinates(0, 0), 'Antananarivo');
});

test('extractCityFromNominatim extracts city, town, or village from address object', () => {
  assert.equal(
    extractCityFromNominatim({ address: { city: 'Antsiranana' } }),
    'Antsiranana',
  );
  assert.equal(
    extractCityFromNominatim({ address: { town: 'Ambanja' } }),
    'Ambanja',
  );
  assert.equal(
    extractCityFromNominatim({ address: { village: 'Ivato' } }),
    'Ivato',
  );
  assert.equal(
    extractCityFromNominatim({ address: { municipality: 'Mahajanga' } }),
    'Mahajanga',
  );
});

test('extractCityFromNominatim extracts city from display_name string fallback', () => {
  assert.equal(
    extractCityFromNominatim({
      display_name: 'Bazarikely, Antsiranana, Diana, 201, Madagascar',
    }),
    'Antsiranana',
  );
});

test('resolveCityName prioritizes Nominatim result and falls back to coordinate detection', () => {
  const resolved = resolveCityName({
    latitude: -12.28,
    longitude: 49.29,
    nominatimData: { address: { city: 'Antsiranana' } },
  });
  assert.equal(resolved, 'Antsiranana');

  const fallback = resolveCityName({
    latitude: -12.28,
    longitude: 49.29,
  });
  assert.equal(fallback, 'Antsiranana');
});
