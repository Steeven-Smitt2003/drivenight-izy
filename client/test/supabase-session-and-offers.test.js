import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTabIsolatedAuthStorage,
  getOrCreateTabStorageKey,
  normalizeAuthSessionPayload,
  rebaseOfferTimestamps,
} from '../src/lib/supabase-clock.js';

test('normalizeAuthSessionPayload rebases server expires_at to client clock when skewed', () => {
  const clientNowMs = Date.parse('2026-11-09T12:31:50.000Z');
  const serverNowSec = Math.floor(Date.parse('2026-11-09T08:31:50.000Z') / 1000);
  const payload = {
    access_token: 'jwt-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: serverNowSec + 3600,
  };

  const normalized = normalizeAuthSessionPayload(payload, clientNowMs);
  assert.equal(normalized.expires_at, Math.floor(clientNowMs / 1000) + 3600);
});

test('createTabIsolatedAuthStorage keeps passenger and driver sessions isolated per tab', () => {
  const localMap = new Map();
  const tab1Map = new Map();
  const tab2Map = new Map();
  const mockStorage = (map) => ({
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  });

  const localStorage = mockStorage(localMap);
  const tab1SessionStorage = mockStorage(tab1Map);
  const tab2SessionStorage = mockStorage(tab2Map);

  const tab1Key = getOrCreateTabStorageKey(tab1SessionStorage);
  const tab2Key = getOrCreateTabStorageKey(tab2SessionStorage);
  assert.notEqual(tab1Key, tab2Key);
  assert.equal(getOrCreateTabStorageKey(tab1SessionStorage), tab1Key);

  const tab1Storage = createTabIsolatedAuthStorage({
    sessionStorage: tab1SessionStorage,
    localStorage,
    now: () => Date.parse('2026-11-09T12:30:00.000Z'),
  });
  const tab2Storage = createTabIsolatedAuthStorage({
    sessionStorage: tab2SessionStorage,
    localStorage,
    now: () => Date.parse('2026-11-09T12:31:00.000Z'),
  });

  tab1Storage.setItem(tab1Key, JSON.stringify({
    access_token: 'passenger-token',
    refresh_token: 'passenger-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.parse('2026-11-09T09:30:00.000Z') / 1000),
    user: { id: 'passenger-1' },
  }));

  tab2Storage.setItem(tab2Key, JSON.stringify({
    access_token: 'driver-token',
    refresh_token: 'driver-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.parse('2026-11-09T09:31:00.000Z') / 1000),
    user: { id: 'driver-1' },
  }));

  const tab1Session = JSON.parse(tab1Storage.getItem(tab1Key));
  const tab2Session = JSON.parse(tab2Storage.getItem(tab2Key));
  assert.equal(tab1Session.user.id, 'passenger-1');
  assert.equal(tab2Session.user.id, 'driver-1');
  assert.ok(tab1Session.expires_at * 1000 > Date.parse('2026-11-09T12:30:00.000Z'));
  assert.ok(tab2Session.expires_at * 1000 > Date.parse('2026-11-09T12:31:00.000Z'));
});

test('rebaseOfferTimestamps preserves 15s countdown when client clock is skewed from server clock', () => {
  const clientNowMs = Date.parse('2026-11-09T12:31:50.000Z');
  const serverNowIso = '2026-11-09T08:31:50.000Z';
  const timedOfferRow = {
    created_at: '2026-11-09T08:31:49.000Z',
    expires_at: '2026-11-09T08:32:04.000Z',
  };
  const counterOfferRow = {
    created_at: '2026-11-09T08:31:49.000Z',
    expires_at: null,
  };

  const rebasedTimed = rebaseOfferTimestamps(timedOfferRow, serverNowIso, clientNowMs);
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(rebasedTimed.expiresAt) - clientNowMs) / 1000));
  assert.equal(remainingSeconds, 14);
  assert.equal(Date.parse(rebasedTimed.expiresAt) - Date.parse(rebasedTimed.createdAt), 15_000);

  const rebasedCounter = rebaseOfferTimestamps(counterOfferRow, serverNowIso, clientNowMs);
  assert.equal(rebasedCounter.expiresAt, null);
});
