const ROAD_FACTOR = 1.3;
const SPEED_KMH = { moto: 28, voiture: 22 };
const ROUTER_URL = 'https://router.project-osrm.org/route/v1/driving';

export function haversineKm(from, to) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude))
    * Math.cos(radians(to.latitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

export function estimateTravelMinutes({ distanceKm, category }) {
  const speed = SPEED_KMH[category] ?? SPEED_KMH.voiture;
  return Math.max(1, Math.round((distanceKm * ROAD_FACTOR / speed) * 60));
}

export function formatEta(minutes) {
  if (minutes < 1) return 'moins d’1 min';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = String(rounded % 60).padStart(2, '0');
  return `${hours} h ${rest}`;
}

export function formatDistance(distanceKm) {
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)} m`;
  if (distanceKm < 10) return `${distanceKm.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(distanceKm)} km`;
}

export async function fetchRoadEta(from, to, {
  category,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4_000,
} = {}) {
  const straightKm = haversineKm(from, to);
  const fallback = {
    minutes: estimateTravelMinutes({ distanceKm: straightKm, category }),
    distanceKm: straightKm,
    source: 'estimate',
  };
  if (typeof fetchImpl !== 'function') return fallback;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const url = `${ROUTER_URL}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return fallback;
    const body = await response.json();
    const route = body?.routes?.[0];
    if (body?.code !== 'Ok' || !Number.isFinite(route?.duration) || !Number.isFinite(route?.distance)) {
      return fallback;
    }
    return {
      minutes: Math.max(1, Math.round(route.duration / 60)),
      distanceKm: Math.round(route.distance / 100) / 10,
      source: 'route',
    };
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
