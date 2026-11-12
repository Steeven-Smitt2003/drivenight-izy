import { supabase } from './supabase.js';
import { parseAuthCallbackUrl } from './supabase-auth-link.js';
import { createPhonePasswordAuth } from './phone-password-auth.js';

const KNOWN_ERRORS = [
  'PHONE_INVALID',
  'PHONE_ALREADY_IN_USE',
  'CURRENT_PASSWORD_INVALID',
  'PASSWORD_TOO_SHORT',
  'DRIVER_VEHICLE_REQUIRED',
  'VEHICLE_ALREADY_EXISTS',
  'DRIVER_REQUIRED',
  'ACCOUNT_DISABLED',
  'AUTH_REQUIRED',
];

function requireSupabase() {
  if (!supabase) throw new Error('SUPABASE_NOT_CONFIGURED');
  return supabase;
}

function rpcError(error) {
  const message = String(error?.message ?? '');
  const code = KNOWN_ERRORS.find((candidate) => message.includes(candidate));
  return new Error(code ?? 'SUPABASE_REQUEST_FAILED');
}

function profilePhotoUrl(profile) {
  if (!profile.photo_path) return null;
  const url = requireSupabase().storage.from('profile-photos').getPublicUrl(profile.photo_path).data.publicUrl;
  const version = Date.parse(profile.updated_at ?? '');
  return Number.isFinite(version) ? `${url}?v=${version}` : url;
}

function profileFromRows(profile, driver) {
  if (!profile) throw new Error('PROFILE_NOT_FOUND');
  return {
    id: profile.id,
    role: profile.role,
    name: profile.name,
    phone: profile.phone,
    photoUrl: profilePhotoUrl(profile),
    averageRating: profile.average_rating,
    ratingCount: profile.rating_count,
    email: profile.email ?? null,
    vehicleCategory: driver?.vehicle_category ?? null,
    vehicleMake: driver?.vehicle_make ?? null,
    vehicleModel: driver?.vehicle_model ?? null,
    vehicleColor: driver?.vehicle_color ?? null,
    vehicleRegistration: driver?.vehicle_registration ?? null,
    isOnline: driver?.is_online ?? false,
    vehicles: driver ? [{
      id: driver.user_id,
      category: driver.vehicle_category,
      make: driver.vehicle_make,
      model: driver.vehicle_model,
      color: driver.vehicle_color,
      registration: driver.vehicle_registration,
    }] : [],
  };
}

export async function registerSupabaseAccount({ phone, password, metadata }) {
  const client = requireSupabase();
  const { user, session } = await createPhonePasswordAuth(client).register({
    phone,
    password,
    metadata,
  });
  return { token: session.access_token, user: await loadSupabaseProfile(user.id) };
}

export async function loginSupabaseAccount({ phone, password }) {
  const client = requireSupabase();
  const { user, session } = await createPhonePasswordAuth(client).login({ phone, password });
  return { token: session.access_token, user: await loadSupabaseProfile(user.id) };
}

export async function restoreSupabaseSessionFromUrl(url) {
  const tokens = parseAuthCallbackUrl(url);
  if (!tokens) return null;

  const { data, error } = await requireSupabase().auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error) throw error;
  if (!data.session) throw new Error('AUTH_SESSION_MISSING');

  return {
    token: data.session.access_token,
    user: await loadSupabaseProfile(data.session.user.id),
  };
}

export async function loadSupabaseProfile(userId) {
  const client = requireSupabase();
  const [{ data: profile, error: profileError }, { data: driver, error: driverError }] = await Promise.all([
    client.from('profiles').select('*').eq('id', userId).single(),
    client.from('driver_profiles').select('*').eq('user_id', userId).maybeSingle(),
  ]);
  if (profileError) throw profileError;
  if (driverError) throw driverError;
  return profileFromRows(profile, driver);
}

export async function restoreSupabaseSession() {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) return null;
  return {
    token: data.session.access_token,
    user: await loadSupabaseProfile(data.session.user.id),
  };
}

export async function signOutSupabase() {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export async function updateSupabaseProfile({ userId, name, photo, removePhoto = false }) {
  const client = requireSupabase();
  const photoPath = `${userId}/profile.jpg`;
  if (photo) {
    const contentType = String(photo.type ?? '').startsWith('image/') ? photo.type : 'image/jpeg';
    const { error: uploadError } = await client.storage
      .from('profile-photos')
      .upload(photoPath, photo, { contentType, upsert: true });
    if (uploadError) throw uploadError;
  }
  const updates = { name: name.trim(), updated_at: new Date().toISOString() };
  if (photo) updates.photo_path = photoPath;
  else if (removePhoto) updates.photo_path = null;
  const { error } = await client.from('profiles').update(updates).eq('id', userId);
  if (error) throw error;
  if (removePhoto && !photo) {
    const { error: removeError } = await client.storage.from('profile-photos').remove([photoPath]);
    if (removeError) throw removeError;
  }
  return loadSupabaseProfile(userId);
}

export async function changeSupabasePhone({ userId, phone, password }) {
  const { error } = await requireSupabase().rpc('change_my_phone', {
    p_new_phone: phone,
    p_password: password,
  });
  if (error) throw rpcError(error);
  return loadSupabaseProfile(userId);
}

export async function changeSupabasePassword({ currentPassword, newPassword }) {
  const { error } = await requireSupabase().rpc('change_my_password', {
    p_current: currentPassword,
    p_new: newPassword,
  });
  if (error) throw rpcError(error);
}

export async function updateSupabaseVehicle({ userId, make, model, color, registration }) {
  const { error } = await requireSupabase().rpc('update_my_vehicle', {
    p_make: make ?? '',
    p_model: model ?? '',
    p_color: color ?? '',
    p_registration: registration ?? '',
  });
  if (error) throw rpcError(error);
  return loadSupabaseProfile(userId);
}
