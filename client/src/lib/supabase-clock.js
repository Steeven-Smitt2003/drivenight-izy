const LATEST_SESSION_FALLBACK_KEY = 'drivenight.supabase.auth.latest';

export function getOrCreateTabStorageKey(
  sessionStorage = globalThis.window?.sessionStorage ?? null,
  baseKey = 'drivenight.supabase.auth',
) {
  if (!sessionStorage) return baseKey;
  try {
    const tabIdKey = `${baseKey}.tab-id`;
    let tabId = sessionStorage.getItem(tabIdKey);
    if (!tabId) {
      tabId = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(tabIdKey, tabId);
    }
    return `${baseKey}.${tabId}`;
  } catch {
    return baseKey;
  }
}

export function normalizeAuthSessionPayload(payload, clientNowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return payload;

  const clientNowSec = Math.floor(clientNowMs / 1000);
  const copy = { ...payload };

  if (typeof copy.access_token === 'string' && typeof copy.expires_in === 'number' && copy.expires_in > 0) {
    const savedAtMs = typeof copy._client_saved_at === 'number' ? copy._client_saved_at : clientNowMs;
    const elapsedSec = Math.max(0, Math.floor((clientNowMs - savedAtMs) / 1000));
    const remainingSec = Math.max(60, copy.expires_in - elapsedSec);
    const expectedExpiresAt = clientNowSec + remainingSec;

    if (typeof copy.expires_at !== 'number' || Math.abs(copy.expires_at - expectedExpiresAt) > 60) {
      copy.expires_at = expectedExpiresAt;
    }
    copy._client_saved_at = savedAtMs;
  }

  if (copy.session && typeof copy.session === 'object') {
    copy.session = normalizeAuthSessionPayload(copy.session, clientNowMs);
  }

  return copy;
}

function isUserSuffixKey(key) {
  return typeof key === 'string' && key.endsWith('-user');
}

function findLegacySupabaseSession(localStorage) {
  if (!localStorage || typeof localStorage.length !== 'number' || typeof localStorage.key !== 'function') {
    return null;
  }
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        const val = localStorage.getItem(k);
        if (val) return val;
      }
    }
  } catch {
    // Ignore storage enumeration errors
  }
  return null;
}

export function createTabIsolatedAuthStorage({
  sessionStorage = globalThis.window?.sessionStorage ?? null,
  localStorage = globalThis.window?.localStorage ?? null,
  now = () => Date.now(),
} = {}) {
  return {
    getItem(key) {
      let raw = sessionStorage?.getItem(key) ?? null;
      if (raw === null && localStorage && !isUserSuffixKey(key)) {
        raw = localStorage.getItem(key)
          ?? localStorage.getItem(LATEST_SESSION_FALLBACK_KEY)
          ?? findLegacySupabaseSession(localStorage);
        if (raw !== null) {
          try {
            sessionStorage?.setItem(key, raw);
          } catch {
            // Ignore storage quota errors
          }
        }
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const normalized = normalizeAuthSessionPayload(parsed, now());
        const serialized = JSON.stringify(normalized);
        if (serialized !== raw) {
          try {
            sessionStorage?.setItem(key, serialized);
          } catch {
            // Ignore storage quota errors
          }
        }
        return serialized;
      } catch {
        return raw;
      }
    },
    setItem(key, value) {
      let serialized = String(value);
      let isSessionObject = false;
      try {
        const parsed = JSON.parse(serialized);
        if (parsed && typeof parsed === 'object' && typeof parsed.access_token === 'string') {
          isSessionObject = true;
          parsed._client_saved_at = now();
          serialized = JSON.stringify(normalizeAuthSessionPayload(parsed, parsed._client_saved_at));
        }
      } catch {
        // Keep original string if not JSON
      }
      try {
        sessionStorage?.setItem(key, serialized);
      } catch {
        // Ignore storage quota errors
      }
      try {
        localStorage?.setItem(key, serialized);
        if (isSessionObject && !isUserSuffixKey(key)) {
          localStorage?.setItem(LATEST_SESSION_FALLBACK_KEY, serialized);
        }
      } catch {
        // Ignore storage quota errors
      }
    },
    removeItem(key) {
      const currentTabRaw = sessionStorage?.getItem(key) ?? null;
      try {
        sessionStorage?.removeItem(key);
      } catch {
        // Ignore storage errors
      }
      try {
        localStorage?.removeItem(key);
        if (!isUserSuffixKey(key)) {
          const fallbackRaw = localStorage?.getItem(LATEST_SESSION_FALLBACK_KEY) ?? null;
          if (!fallbackRaw || !currentTabRaw) {
            localStorage?.removeItem(LATEST_SESSION_FALLBACK_KEY);
            return;
          }
          const currentUserId = JSON.parse(currentTabRaw)?.user?.id;
          const fallbackUserId = JSON.parse(fallbackRaw)?.user?.id;
          if (!currentUserId || currentUserId === fallbackUserId) {
            localStorage?.removeItem(LATEST_SESSION_FALLBACK_KEY);
          }
        }
      } catch {
        // Ignore storage errors
      }
    },
  };
}

export function createClockAwareSupabaseFetch(
  baseFetch = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
) {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url ?? '';

    if (!url.includes('/auth/v1/') || !response.ok) {
      return response;
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return response;
    }

    try {
      const clone = response.clone();
      const body = await clone.json();
      if (!body || typeof body !== 'object' || (!body.access_token && !body.session?.access_token)) {
        return response;
      }
      const normalized = normalizeAuthSessionPayload(body, now());
      return new Response(JSON.stringify(normalized), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
}

export function rebaseOfferTimestamps(row, serverNowIso, clientNowMs = Date.now()) {
  const createdAt = row?.created_at ?? null;
  const expiresAt = row?.expires_at ?? null;
  if (!expiresAt) {
    return { createdAt, expiresAt: null };
  }

  const serverNowMs = serverNowIso ? Date.parse(serverNowIso) : NaN;
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  const expiresMs = Date.parse(expiresAt);

  if (!Number.isFinite(serverNowMs) || !Number.isFinite(expiresMs)) {
    return { createdAt, expiresAt };
  }

  const offsetMs = clientNowMs - serverNowMs;
  if (Math.abs(offsetMs) <= 1_000) {
    return { createdAt, expiresAt };
  }

  return {
    createdAt: Number.isFinite(createdMs)
      ? new Date(createdMs + offsetMs).toISOString()
      : createdAt,
    expiresAt: new Date(expiresMs + offsetMs).toISOString(),
  };
}
