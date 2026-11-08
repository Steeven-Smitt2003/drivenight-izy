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
