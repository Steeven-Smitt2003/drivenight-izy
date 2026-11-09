import { supabaseEnabled } from './supabase.js';
import { supabase } from './supabase.js';
import { supabaseApiFetch } from './supabase-api.js';

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';

if (configuredApiBaseUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(configuredApiBaseUrl);
  } catch {
    throw new Error('VITE_API_BASE_URL doit être une origine HTTP ou HTTPS valide.');
  }

  if (!['http:', 'https:'].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== '/'
    || baseUrl.search
    || baseUrl.hash) {
    throw new Error('VITE_API_BASE_URL doit contenir uniquement l’origine HTTP ou HTTPS de l’API.');
  }
}

const apiBaseUrl = configuredApiBaseUrl.replace(/\/+$/, '');

export function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('Les chemins DriveNight doivent commencer par /api/.');
  }

  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

export function apiFetch(path, options) {
  if (supabaseEnabled) return supabaseApiFetch(path, options);
  return fetch(apiUrl(path), options);
}

export function apiAssetUrl(path) {
  return typeof path === 'string' && path.startsWith('/api/')
    ? apiUrl(path)
    : path;
}

export function apiWebSocketUrl(path) {
  const endpoint = new URL(apiUrl(path), window.location.href);
  if (endpoint.protocol === 'https:') {
    endpoint.protocol = 'wss:';
  } else if (endpoint.protocol === 'http:') {
    endpoint.protocol = 'ws:';
  } else {
    throw new Error('Configurez VITE_API_BASE_URL pour connecter le temps réel.');
  }
  return endpoint.toString();
}

export function apiRealtimeConnect(path) {
  if (!supabaseEnabled) {
    if (!path) throw new TypeError('Un chemin WebSocket est requis pour l’API Fastify.');
    return new WebSocket(apiWebSocketUrl(path));
  }

  const listeners = new Map();
  const channelId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = supabase.channel(`drivenight-${channelId}`);
  const connection = {
    readyState: 0,
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      const entry = { listener, once: Boolean(options.once) };
      listeners.get(type).add(entry);
    },
    send() {},
    close() {
      if (connection.readyState === 3) return;
      connection.readyState = 3;
      void supabase.removeChannel(channel);
      dispatch('close', {});
    },
  };
  function dispatch(type, event) {
    for (const entry of [...(listeners.get(type) ?? [])]) {
      entry.listener(event);
      if (entry.once) listeners.get(type).delete(entry);
    }
  }
  const emitChange = (table, payload) => {
    const row = payload.new ?? payload.old;
    if (!row) return;
    const message = {
      type: table === 'rides'
        ? payload.eventType === 'INSERT' ? 'ride.available' : 'ride.updated'
        : table === 'ride_offers' ? 'offers.updated'
          : table === 'chat_messages' ? 'message.created'
            : 'ride.location.updated',
      rideId: table === 'rides' ? row.id : row.ride_id,
    };
    if (table === 'rides') message.status = row.status;
    if (table === 'ride_locations') {
      message.location = {
        latitude: row.latitude,
        longitude: row.longitude,
        updatedAt: row.updated_at,
      };
    }
    dispatch('message', { data: JSON.stringify(message) });
  };

  for (const table of ['rides', 'ride_offers', 'chat_messages', 'ride_locations']) {
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table,
    }, (payload) => emitChange(table, payload));
  }
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED' && connection.readyState !== 3) {
      connection.readyState = 1;
      dispatch('open', {});
    } else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) {
      dispatch('error', {});
      connection.close();
    } else if (status === 'CLOSED' && connection.readyState !== 3) {
      connection.readyState = 3;
      dispatch('close', {});
    }
  });
  return connection;
}
