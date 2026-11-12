import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));

test('AndroidManifest.xml declares INTERNET, ACCESS_COARSE_LOCATION, and ACCESS_FINE_LOCATION permissions for native GPS', () => {
  const manifestPath = join(rootDir, 'android/app/src/main/AndroidManifest.xml');
  const manifest = readFileSync(manifestPath, 'utf8');

  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(manifest, /android\.hardware\.location\.gps/);
});

test('capacitor.config.json points to client/dist for native Android packaging', () => {
  const configPath = join(rootDir, 'capacitor.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  assert.equal(config.appId, 'mg.drivenight.app');
  assert.equal(config.appName, 'DriveNight');
  assert.equal(config.webDir, 'client/dist');
});
