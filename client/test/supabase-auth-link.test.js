import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmailRedirectTo, parseAuthCallbackUrl } from '../src/lib/supabase-auth-link.js';

test('native auth redirects return to the DriveNight Android callback', () => {
  assert.equal(
    getEmailRedirectTo({ isNative: true, origin: 'capacitor://localhost' }),
    'mg.drivenight.app://auth/callback',
  );
});

test('web auth redirects return to the current app origin', () => {
  assert.equal(
    getEmailRedirectTo({ isNative: false, origin: 'http://localhost:5173' }),
    'http://localhost:5173',
  );
});

test('auth callback extracts Supabase session tokens from a URL fragment', () => {
  assert.deepEqual(
    parseAuthCallbackUrl(
      'mg.drivenight.app://auth/callback#access_token=access-value&refresh_token=refresh-value&type=signup',
    ),
    { accessToken: 'access-value', refreshToken: 'refresh-value' },
  );
});

test('auth callback reports Supabase confirmation errors instead of ignoring them', () => {
  assert.throws(
    () => parseAuthCallbackUrl(
      'mg.drivenight.app://auth/callback#error=access_denied&error_description=Email+link+is+invalid',
    ),
    /Email link is invalid/,
  );
});

test('unrelated deep links do not create an auth session', () => {
  assert.equal(parseAuthCallbackUrl('mg.drivenight.app://auth/callback'), null);
});
