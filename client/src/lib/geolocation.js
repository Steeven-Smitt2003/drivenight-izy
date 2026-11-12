function createGeolocationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function geolocationErrorMessage(error) {
  const code = error?.code;
  if (code === 1 || code === 'PERMISSION_DENIED') {
    return 'Autorisez l’accès à votre position dans le navigateur pour vous localiser sur la carte.';
  }
  if (code === 2 || code === 'POSITION_UNAVAILABLE') {
    return 'Votre position GPS est actuellement indisponible. Vérifiez que la localisation est activée.';
  }
  if (code === 3 || code === 'TIMEOUT') {
    return 'La localisation a pris trop de temps. Réessayez dans un endroit dégagé.';
  }
  if (code === 'GEOLOCATION_UNSUPPORTED') {
    return 'La géolocalisation n’est pas disponible sur cet appareil.';
  }
  return 'Votre position actuelle n’a pas pu être récupérée. Réessayez.';
}

function getPositionOnce(geolocation, options) {
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        const latitude = Number(position?.coords?.latitude);
        const longitude = Number(position?.coords?.longitude);
        const accuracy = Number(position?.coords?.accuracy);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(createGeolocationError(2, 'Coordonnées GPS invalides.'));
          return;
        }
        resolve({
          latitude,
          longitude,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
        });
      },
      (error) => reject(error),
      options,
    );
  });
}

export async function requestCurrentPosition(
  geolocation = globalThis.navigator?.geolocation,
  options = {},
) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    throw createGeolocationError(
      'GEOLOCATION_UNSUPPORTED',
      'La géolocalisation n’est pas disponible sur cet appareil.',
    );
  }

  const primaryOptions = {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 8_000,
    ...options,
  };

  try {
    return await getPositionOnce(geolocation, primaryOptions);
  } catch (error) {
    const isRetryable = error?.code === 2 || error?.code === 3;
    if (!primaryOptions.enableHighAccuracy || !isRetryable) {
      throw error;
    }
    return getPositionOnce(geolocation, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
      timeout: 10_000,
    });
  }
}
