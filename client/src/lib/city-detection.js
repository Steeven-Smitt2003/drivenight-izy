const KNOWN_CITIES = [
  { name: 'Nosy Be', minLat: -13.5, maxLat: -13.1, minLon: 48.1, maxLon: 48.45 },
  { name: 'Antsiranana', minLat: -12.7, maxLat: -11.8, minLon: 49.0, maxLon: 49.7 },
  { name: 'Mahajanga', minLat: -16.0, maxLat: -15.4, minLon: 46.1, maxLon: 46.6 },
  { name: 'Toamasina', minLat: -18.4, maxLat: -17.8, minLon: 49.1, maxLon: 49.7 },
  { name: 'Antananarivo', minLat: -19.2, maxLat: -18.6, minLon: 47.3, maxLon: 47.8 },
  { name: 'Antsirabe', minLat: -20.1, maxLat: -19.6, minLon: 46.8, maxLon: 47.3 },
  { name: 'Morondava', minLat: -20.6, maxLat: -20.0, minLon: 44.0, maxLon: 44.5 },
  { name: 'Fianarantsoa', minLat: -21.8, maxLat: -21.2, minLon: 46.8, maxLon: 47.3 },
  { name: 'Toliara', minLat: -23.6, maxLat: -23.1, minLon: 43.4, maxLon: 43.9 },
  { name: 'Taolagnaro', minLat: -25.3, maxLat: -24.7, minLon: 46.8, maxLon: 47.3 },
  { name: 'Sambava', minLat: -14.5, maxLat: -14.0, minLon: 49.9, maxLon: 50.4 },
];

export function detectCityFromCoordinates(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return 'Antananarivo';
  }
  for (const city of KNOWN_CITIES) {
    if (
      latitude >= city.minLat
      && latitude <= city.maxLat
      && longitude >= city.minLon
      && longitude <= city.maxLon
    ) {
      return city.name;
    }
  }
  return 'Antananarivo';
}

export function extractCityFromNominatim(place) {
  if (!place) return null;
  const address = place.address;
  if (address) {
    const candidate = address.city
      || address.town
      || address.village
      || address.municipality
      || address.county;
    if (candidate && typeof candidate === 'string') {
      return candidate.trim();
    }
  }

  const displayName = place.display_name;
  if (typeof displayName === 'string') {
    for (const city of KNOWN_CITIES) {
      const regex = new RegExp(`\\b${city.name}\\b`, 'i');
      if (regex.test(displayName)) {
        return city.name;
      }
    }
    const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return parts[1];
    }
  }

  return null;
}

export function resolveCityName({ latitude, longitude, nominatimData } = {}) {
  const fromNominatim = extractCityFromNominatim(nominatimData);
  if (fromNominatim) return fromNominatim;
  return detectCityFromCoordinates(latitude, longitude);
}
