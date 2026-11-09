export const authCallbackUrl = 'mg.drivenight.app://auth/callback';

export function getEmailRedirectTo({ isNative, origin }) {
  return isNative ? authCallbackUrl : origin;
}

export function parseAuthCallbackUrl(value) {
  const url = new URL(value);
  const params = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  const error = params.get('error_description') ?? params.get('error');
  if (error) throw new Error(error.replace(/\+/g, ' '));

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken && !refreshToken) return null;
  if (!accessToken || !refreshToken) throw new Error('AUTH_SESSION_MISSING');

  return { accessToken, refreshToken };
}
