import { supabase } from './supabase.js';
import { rebaseOfferTimestamps } from './supabase-clock.js';

const placeCache = new Map();
const pendingPlaceRequests = new Map();
let lastPlaceRequestAt = 0;
let placeRequestQueue = Promise.resolve();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(error, fallback = 'SUPABASE_REQUEST_FAILED') {
  const message = error?.message ?? fallback;
  const knownCodes = [
    'AUTH_REQUIRED',
    'ACCOUNT_DISABLED',
    'ADMIN_REQUIRED',
    'ACCOUNT_NOT_FOUND',
    'ACCOUNT_HAS_ACTIVE_RIDE',
    'CANNOT_DELETE_SELF',
    'PHONE_ALREADY_IN_USE',
    'NAME_INVALID',
    'PHONE_INVALID',
    'PASSWORD_TOO_SHORT',
    'ADMIN_FILTER_INVALID',
    'DRIVER_NOT_AVAILABLE',
    'DRIVER_HAS_ACTIVE_RIDE',
    'RIDE_NOT_OPEN',
    'RIDE_NOT_FOUND',
    'RIDE_CANNOT_BE_CANCELLED',
    'RIDE_STATUS_INVALID',
    'RIDE_STATUS_TRANSITION_INVALID',
    'RIDE_CATEGORY_MISMATCH',
    'RIDE_PRICE_UNAVAILABLE',
    'RIDE_PARTICIPANT_REQUIRED',
    'ROUTE_POINTS_MUST_DIFFER',
    'OFFER_ALREADY_SUBMITTED',
    'OFFER_NOT_RESPONDABLE',
    'OFFER_NOT_ACCEPTABLE',
    'OFFER_NOT_REJECTABLE',
    'RIDE_CHAT_NOT_ACTIVE',
    'RATING_ALREADY_SUBMITTED',
    'RIDE_NOT_COMPLETED',
    'PASSENGER_REQUIRED',
    'DRIVER_REQUIRED',
    'PROFILE_NOT_FOUND',
    'SUPABASE_ENDPOINT_NOT_MIGRATED',
  ];
  const code = knownCodes.find((candidate) => message.includes(candidate)) ?? fallback;
  const status = code === 'SUPABASE_ENDPOINT_NOT_MIGRATED' ? 501
    : code === 'AUTH_REQUIRED' || code === 'ACCOUNT_DISABLED' ? 401
      : code === 'ADMIN_REQUIRED' || code === 'RIDE_PARTICIPANT_REQUIRED' ? 403
    : code.includes('NOT_FOUND') ? 404
      : code.includes('INVALID') || code.includes('NOT_OPEN')
        || code.includes('NOT_RESPONDABLE') || code.includes('NOT_ACCEPTABLE')
        || code.includes('NOT_REJECTABLE') || code.includes('ALREADY')
        || code.includes('CANNOT') || code.includes('MISMATCH')
        || code.includes('ACTIVE_RIDE') ? 409 : 400;
  return jsonResponse({ error: code }, status);
}

function requireSupabase() {
  if (!supabase) throw new Error('SUPABASE_NOT_CONFIGURED');
  return supabase;
}

async function result(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function expireTimedOffers(rideId = null) {
  const client = requireSupabase();
  try {
    await client.rpc('expire_stale_rides').catch(() => {});
    return await result(
      client.rpc('expire_timed_ride_offers', rideId ? { p_ride_id: rideId } : {}),
    );
  } catch {
    return null;
  }
}

function mapRide(row, initialOfferId = null, participants = {}) {
  return {
    id: row.id,
    passengerId: row.passenger_id,
    driverId: row.driver_id ?? null,
    passenger: participants.passenger ?? null,
    driver: participants.driver ?? null,
    cancelledBy: row.cancelled_by ?? null,
    origin: {
      label: row.origin_label,
      latitude: row.origin_latitude,
      longitude: row.origin_longitude,
    },
    destination: {
      label: row.destination_label,
      latitude: row.destination_latitude,
      longitude: row.destination_longitude,
    },
    category: row.category,
    proposedPriceMGA: row.proposed_price_mga,
    agreedPriceMGA: row.agreed_price_mga ?? null,
    initialOfferId,
    status: row.status,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at ?? null,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
  };
}

async function withInitialOffers(rows) {
  if (!rows.length) return [];
  const client = requireSupabase();
  const ids = rows.map((row) => row.id);
  const offers = await result(client.from('ride_offers')
    .select('id, ride_id')
    .in('ride_id', ids)
    .is('responds_to_offer_id', null));
  const byRide = new Map(offers.map((offer) => [offer.ride_id, offer.id]));
  const profiles = await publicProfiles(
    rows.flatMap((row) => [row.passenger_id, row.driver_id]),
  );
  return rows.map((row) => mapRide(row, byRide.get(row.id) ?? null, {
    passenger: profiles.get(row.passenger_id) ?? null,
    driver: row.driver_id ? profiles.get(row.driver_id) ?? null : null,
  }));
}

async function contactPhones(userIds) {
  try {
    const rows = await result(requireSupabase().rpc('contact_phones', { p_user_ids: userIds }));
    return new Map((rows ?? []).map((row) => [row.user_id, row.phone]));
  } catch {
    return new Map();
  }
}

async function publicProfiles(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const client = requireSupabase();
  const [profiles, drivers, phones] = await Promise.all([
    result(client.from('public_profiles').select('*').in('id', ids)),
    result(client.from('public_driver_profiles').select('*').in('user_id', ids)),
    contactPhones(ids),
  ]);
  const driverById = new Map(drivers.map((row) => [row.user_id, row]));
  return new Map(profiles.map((profile) => {
    const driver = driverById.get(profile.id);
    return [profile.id, {
      id: profile.id,
      role: profile.role,
      name: profile.name,
      phone: phones.get(profile.id) ?? null,
      photoUrl: profile.photo_path
        ? client.storage.from('profile-photos').getPublicUrl(profile.photo_path).data.publicUrl
        : null,
      averageRating: profile.average_rating,
      ratingCount: profile.rating_count,
      vehicleCategory: driver?.vehicle_category ?? null,
      vehicleMake: driver?.vehicle_make ?? null,
      vehicleModel: driver?.vehicle_model ?? null,
      vehicleColor: driver?.vehicle_color ?? null,
      vehicleRegistration: driver?.vehicle_registration ?? null,
      isOnline: driver?.is_online ?? false,
    }];
  }));
}

async function fetchNominatim(url) {
  const cacheKey = url.toString();
  const cached = placeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (pendingPlaceRequests.has(cacheKey)) return pendingPlaceRequests.get(cacheKey);

  const request = placeRequestQueue.then(async () => {
    const delay = Math.max(0, 1_000 - (Date.now() - lastPlaceRequestAt));
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    lastPlaceRequestAt = Date.now();
    const response = await fetch(url, { headers: { 'accept-language': 'fr' } });
    if (!response.ok) throw new Error('PLACE_LOOKUP_UNAVAILABLE');
    const data = await response.json();
    placeCache.set(cacheKey, { data, expiresAt: Date.now() + 10 * 60_000 });
    return data;
  });
  placeRequestQueue = request.catch(() => {});
  pendingPlaceRequests.set(cacheKey, request);
  request.finally(() => pendingPlaceRequests.delete(cacheKey)).catch(() => {});
  return request;
}

async function mapOffers(rows, serverNowIso = null, rideRow = null) {
  const userIds = rows.map((row) => row.proposer_id);
  if (rideRow?.driver_id) userIds.push(rideRow.driver_id);
  const profiles = await publicProfiles(userIds);
  const acceptedDriver = rideRow?.driver_id ? profiles.get(rideRow.driver_id) ?? null : null;
  const nowMs = Date.now();

  return rows.map((row) => {
    const timestamps = rebaseOfferTimestamps(row, serverNowIso, nowMs);
    const acceptedBy = acceptedDriver
      && row.status === 'accepted'
      && row.proposer_id === rideRow?.passenger_id
      ? acceptedDriver
      : null;

    return {
      id: row.id,
      rideId: row.ride_id,
      proposerId: row.proposer_id,
      amountMGA: row.amount_mga,
      respondsToOfferId: row.responds_to_offer_id,
      status: row.status,
      createdAt: timestamps.createdAt,
      expiresAt: timestamps.expiresAt,
      proposer: profiles.get(row.proposer_id) ?? { id: row.proposer_id },
      ...(acceptedBy ? { acceptedBy } : {}),
    };
  });
}

function mapMessage(row, sender) {
  return {
    id: row.id,
    rideId: row.ride_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    sender,
  };
}

function photoUrl(photoPath) {
  return photoPath
    ? requireSupabase().storage.from('profile-photos').getPublicUrl(photoPath).data.publicUrl
    : null;
}

function mapAdminAccount(account) {
  const { photoPath, ...rest } = account;
  return { ...rest, photoUrl: photoUrl(photoPath) };
}

function mapAdminOperations(operations) {
  return {
    ...operations,
    onlineDrivers: operations.onlineDrivers.map((driver) => {
      const { photoPath, ...rest } = driver;
      return { ...rest, photoUrl: photoUrl(photoPath) };
    }),
    onlinePassengers: operations.onlinePassengers.map((passenger) => {
      const { photoPath, ...rest } = passenger;
      return { ...rest, photoUrl: photoUrl(photoPath) };
    }),
  };
}

async function activeRideParticipant(rideId) {
  return result(requireSupabase().from('rides')
    .select('id, passenger_id, driver_id, status')
    .eq('id', rideId)
    .maybeSingle());
}

async function getRide(rideId) {
  return result(requireSupabase().from('rides').select('*').eq('id', rideId).single());
}

async function getRideMessages(rideId) {
  const client = requireSupabase();
  const rows = await result(client.from('chat_messages')
    .select('*')
    .eq('ride_id', rideId)
    .order('created_at'));
  const profiles = await publicProfiles(rows.map((row) => row.sender_id));
  return rows.map((row) => mapMessage(row, profiles.get(row.sender_id)));
}

async function handle(path, options = {}) {
  const client = requireSupabase();
  const method = (options.method ?? 'GET').toUpperCase();
  const url = new URL(path, window.location.origin);
  const route = url.pathname;
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body ?? {};
  const rideRoute = route.match(/^\/api\/rides\/([^/]+)(?:\/(.*))?$/);
  const rideId = rideRoute ? decodeURIComponent(rideRoute[1]) : null;
  const rideAction = rideRoute?.[2] ?? '';

  if (route === '/api/presence' && method === 'POST') {
    await result(client.rpc('set_account_presence'));
    return jsonResponse({ ok: true });
  }

  if (route === '/api/admin/summary' && method === 'GET') {
    return jsonResponse(await result(client.rpc('admin_summary')));
  }

  if (route === '/api/admin/accounts' && method === 'GET') {
    const accounts = await result(client.rpc('admin_accounts', {
      p_query: url.searchParams.get('q') ?? '',
      p_role: url.searchParams.get('role') ?? 'all',
      p_status: url.searchParams.get('status') ?? 'all',
    }));
    return jsonResponse({
      accounts: (accounts.accounts ?? []).map(mapAdminAccount),
    });
  }

  if (route === '/api/admin/accounts' && method === 'POST') {
    const account = await result(client.rpc('admin_create_admin', {
      p_name: body.name,
      p_phone: body.phone,
      p_password: body.password,
      p_email: body.email || null,
    }));
    return jsonResponse({ account }, 201);
  }

  if (route === '/api/admin/operations' && method === 'GET') {
    return jsonResponse(mapAdminOperations(
      await result(client.rpc('admin_operations')),
    ));
  }

  const adminAccountRoute = route.match(/^\/api\/admin\/accounts\/([^/]+)\/status$/);
  if (adminAccountRoute && method === 'PATCH') {
    if (typeof body.isActive !== 'boolean') {
      return jsonResponse({ error: 'ADMIN_STATUS_INVALID' }, 400);
    }
    return jsonResponse(await result(client.rpc('admin_set_account_status', {
      p_account_id: decodeURIComponent(adminAccountRoute[1]),
      p_is_active: body.isActive,
    })));
  }

  const adminDeleteRoute = route.match(/^\/api\/admin\/accounts\/([^/]+)$/);
  if (adminDeleteRoute && method === 'DELETE') {
    const accountId = decodeURIComponent(adminDeleteRoute[1]);
    await result(client.rpc('admin_delete_account', {
      p_account_id: accountId,
    }));
    return jsonResponse({ success: true });
  }

  if (route === '/api/me' && method === 'GET') {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) return jsonResponse({ error: 'AUTH_REQUIRED' }, 401);
    const [{ data: profile, error: profileError }, { data: driver, error: driverError }] = await Promise.all([
      client.from('profiles').select('*').eq('id', sessionData.session.user.id).single(),
      client.from('driver_profiles').select('*').eq('user_id', sessionData.session.user.id).maybeSingle(),
    ]);
    if (profileError) throw profileError;
    if (driverError) throw driverError;
    const photoUrl = profile.photo_path
      ? client.storage.from('profile-photos').getPublicUrl(profile.photo_path).data.publicUrl
      : null;
    return jsonResponse({
      id: profile.id,
      role: profile.role,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      photoUrl,
      averageRating: profile.average_rating,
      ratingCount: profile.rating_count,
      vehicleCategory: driver?.vehicle_category ?? null,
      vehicleRegistration: driver?.vehicle_registration ?? null,
      activeVehicleId: driver?.user_id ?? null,
      vehicles: driver ? [{
        id: driver.user_id,
        category: driver.vehicle_category,
        make: driver.vehicle_make,
        model: driver.vehicle_model,
        color: driver.vehicle_color,
        registration: driver.vehicle_registration,
        createdAt: driver.created_at,
      }] : [],
      termsAcceptedAt: profile.terms_accepted_at,
      termsVersion: profile.terms_version,
    });
  }

  if (route === '/api/driver/availability' && method === 'GET') {
    const session = await result(client.auth.getSession());
    const driver = await result(client.from('driver_profiles')
      .select('is_online').eq('user_id', session.session.user.id).single());
    return jsonResponse({ isOnline: driver.is_online });
  }
  if (route === '/api/driver/availability' && method === 'PATCH') {
    const online = await result(client.rpc('set_driver_availability', { p_online: Boolean(body.online) }));
    return jsonResponse({ isOnline: online });
  }

  if (route === '/api/rides' && method === 'POST') {
    const rideUuid = await result(client.rpc('create_ride', {
      p_origin_label: body.origin.label,
      p_origin_latitude: body.origin.latitude,
      p_origin_longitude: body.origin.longitude,
      p_destination_label: body.destination.label,
      p_destination_latitude: body.destination.latitude,
      p_destination_longitude: body.destination.longitude,
      p_category: body.category,
      p_proposed_price_mga: body.proposedPriceMGA,
    }));
    const row = await getRide(rideUuid);
    const [ride] = await withInitialOffers([row]);
    return jsonResponse({ ride }, 201);
  }

  if (route === '/api/driver/rides' && method === 'GET') {
    await expireTimedOffers();
    const { data: sessionData } = await client.auth.getSession();
    const userId = sessionData.session.user.id;
    const { data: driver, error: driverError } = await client.from('driver_profiles')
      .select('vehicle_category, is_online')
      .eq('user_id', userId)
      .single();
    if (driverError) throw driverError;
    if (!driver.is_online) return jsonResponse({ rides: [] });
    const [rows, pendingTimedOffers] = await Promise.all([
      result(client.from('rides').select('*')
        .in('status', ['searching', 'negotiating'])
        .eq('category', driver.vehicle_category)
        .order('requested_at', { ascending: false })),
      result(client.from('ride_offers').select('ride_id')
        .eq('proposer_id', userId)
        .eq('status', 'pending')
        .not('expires_at', 'is', null)),
    ]);
    const excludedRideIds = new Set(pendingTimedOffers.map((offer) => offer.ride_id));
    const visibleRows = rows.filter((row) => !excludedRideIds.has(row.id));
    return jsonResponse({ rides: await withInitialOffers(visibleRows) });
  }

  if (route === '/api/driver/active-rides' && method === 'GET') {
    const serverNow = await expireTimedOffers();
    const { data: sessionData } = await client.auth.getSession();
    const userId = sessionData.session.user.id;
    const rows = await result(client.from('rides').select('*')
      .eq('driver_id', userId)
      .in('status', ['driver_en_route', 'driver_arrived', 'in_progress'])
      .order('updated_at', { ascending: false }));
    const rides = await withInitialOffers(rows);
    const pendingRows = await result(client.from('ride_offers').select('*')
      .eq('proposer_id', userId)
      .eq('status', 'pending')
      .not('expires_at', 'is', null)
      .order('created_at', { ascending: false }));
    const pendingRideIds = [...new Set(pendingRows.map((offer) => offer.ride_id))];
    const pendingRideRows = pendingRideIds.length
      ? await result(client.from('rides').select('*').in('id', pendingRideIds))
      : [];
    const pendingRides = await withInitialOffers(pendingRideRows);
    const pendingRideById = new Map(pendingRides.map((ride) => [ride.id, ride]));
    const pendingOffers = (await mapOffers(pendingRows, serverNow))
      .map((offer) => ({ ...offer, ride: pendingRideById.get(offer.rideId) ?? null }));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const completed = await result(client.from('rides').select('completed_at')
      .eq('driver_id', userId).eq('status', 'completed').gte('completed_at', weekStart.toISOString()));
    return jsonResponse({
      rides,
      pendingOffers,
      stats: {
        completedToday: completed.filter((ride) => ride.completed_at >= today.toISOString()).length,
        completedThisWeek: completed.length,
      },
    });
  }

  if (rideId && rideAction === 'offers' && method === 'POST') {
    const offer = await result(client.rpc('create_ride_offer', {
      p_ride_id: rideId,
      p_amount_mga: body.amountMGA,
      p_responds_to_offer_id: body.respondsToOfferId ?? null,
    }));
    return jsonResponse({ offer: (await mapOffers([offer], offer.created_at))[0] }, 201);
  }
  if (rideId && rideAction === 'accept' && method === 'POST') {
    const offer = await result(client.rpc('accept_ride_at_proposed_price', { p_ride_id: rideId }));
    const row = await getRide(rideId);
    const [ride] = await withInitialOffers([row]);
    return jsonResponse({
      offer: (await mapOffers([offer], offer.created_at))[0],
      ride,
      passengerConfirmationSeconds: 15,
    }, 201);
  }
  if (rideId && rideAction === 'offers' && method === 'GET') {
    const serverNow = await expireTimedOffers(rideId);
    const [rideRow, rows] = await Promise.all([
      result(client.from('rides').select('id, passenger_id, driver_id').eq('id', rideId).maybeSingle()),
      result(client.from('ride_offers').select('*').eq('ride_id', rideId).order('created_at')),
    ]);
    return jsonResponse({ offers: await mapOffers(rows, serverNow, rideRow) });
  }

  const offerAction = rideAction.match(/^offers\/([^/]+)\/(accept|reject)$/);
  if (rideId && offerAction && method === 'POST') {
    const offerId = decodeURIComponent(offerAction[1]);
    if (offerAction[2] === 'accept') {
      await result(client.rpc('accept_ride_offer', { p_ride_id: rideId, p_offer_id: offerId }));
    } else {
      await result(client.rpc('reject_ride_offer', { p_ride_id: rideId, p_offer_id: offerId }));
    }
    const row = await getRide(rideId);
    const [ride] = await withInitialOffers([row]);
    return jsonResponse({ ride });
  }

  if (rideId && rideAction === 'cancel' && method === 'POST') {
    const row = await result(client.rpc('cancel_ride', { p_ride_id: rideId }));
    const [ride] = await withInitialOffers([row]);
    return jsonResponse({ ride });
  }
  if (rideId && rideAction === 'status' && method === 'PATCH') {
    const row = await result(client.rpc('update_ride_status', {
      p_ride_id: rideId,
      p_status: body.status,
    }));
    const [ride] = await withInitialOffers([row]);
    return jsonResponse({ ride });
  }
  if (rideId && rideAction === 'location' && method === 'GET') {
    const row = await result(client.from('ride_locations')
      .select('latitude, longitude, updated_at')
      .eq('ride_id', rideId)
      .maybeSingle());
    return jsonResponse({
      location: row
        ? { latitude: row.latitude, longitude: row.longitude, updatedAt: row.updated_at }
        : null,
    });
  }
  if (rideId && rideAction === 'location' && method === 'POST') {
    const location = await result(client.rpc('share_ride_location', {
      p_ride_id: rideId,
      p_latitude: body.latitude,
      p_longitude: body.longitude,
    }));
    return jsonResponse({ location });
  }

  if (rideId && rideAction === 'messages' && method === 'GET') {
    return jsonResponse({ messages: await getRideMessages(rideId) });
  }
  if (rideId && rideAction === 'messages' && method === 'POST') {
    const session = await result(client.auth.getSession());
    const ride = await activeRideParticipant(rideId);
    if (!ride || !['driver_en_route', 'driver_arrived', 'in_progress'].includes(ride.status)) {
      throw new Error('RIDE_CHAT_NOT_ACTIVE');
    }
    const message = await result(client.from('chat_messages').insert({
      ride_id: rideId,
      sender_id: session.session.user.id,
      body: body.body.trim(),
    }).select('*').single());
    const profile = await publicProfiles([message.sender_id]);
    return jsonResponse({ message: mapMessage(message, profile.get(message.sender_id)) }, 201);
  }

  if (route === '/api/rides/history' && method === 'GET') {
    const { data: sessionData } = await client.auth.getSession();
    const userId = sessionData.session.user.id;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await result(client.from('rides').select('*')
      .or(`passenger_id.eq.${userId},driver_id.eq.${userId}`)
      .gte('requested_at', oneDayAgo)
      .order('requested_at', { ascending: false }).limit(100));
    const profileRows = await result(client.from('public_profiles').select('*')
      .in('id', [...new Set(rows.flatMap((ride) => [ride.passenger_id, ride.driver_id]).filter(Boolean))]));
    const profileMap = new Map(profileRows.map((profile) => [profile.id, profile]));
    const ratings = await result(client.from('ratings').select('*')
      .eq('rater_id', userId).in('ride_id', rows.map((ride) => ride.id)));
    const ratingMap = new Map(ratings.map((rating) => [rating.ride_id, rating]));
    return jsonResponse({
      rides: rows.map((row) => {
        const ride = mapRide(row);
        const counterpartyId = row.passenger_id === userId ? row.driver_id : row.passenger_id;
        const peer = profileMap.get(counterpartyId);
        return {
          ...ride,
          counterparty: peer ? {
            id: peer.id,
            name: peer.name,
            photoUrl: peer.photo_path
              ? client.storage.from('profile-photos').getPublicUrl(peer.photo_path).data.publicUrl
              : null,
            averageRating: peer.average_rating,
          } : null,
          myRating: ratingMap.has(row.id) ? {
            stars: ratingMap.get(row.id).stars,
            comment: ratingMap.get(row.id).comment,
          } : null,
        };
      }),
    });
  }

  if (rideId && rideAction === 'ratings' && method === 'POST') {
    const ride = await activeRideParticipant(rideId);
    if (!ride || ride.status !== 'completed') throw new Error('RIDE_NOT_COMPLETED');
    const { data: sessionData } = await client.auth.getSession();
    const userId = sessionData.session.user.id;
    const rating = await result(client.from('ratings').insert({
      ride_id: rideId,
      rater_id: userId,
      ratee_id: ride.passenger_id === userId ? ride.driver_id : ride.passenger_id,
      stars: body.stars,
      comment: body.comment ?? null,
    }).select('*').single());
    return jsonResponse({ rating: { stars: rating.stars, comment: rating.comment } }, 201);
  }

  if (route === '/api/places/search' && method === 'GET') {
    const query = url.searchParams.get('q')?.trim() ?? '';
    const places = await fetchNominatim(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q: `${query}, Antananarivo, Madagascar`,
      format: 'jsonv2',
      limit: '5',
      viewbox: '47.35,-18.75,47.7,-19.05',
      bounded: '1',
    })}`);
    return jsonResponse({ places: places.map((place) => ({
      id: String(place.place_id),
      label: place.display_name,
      latitude: Number(place.lat),
      longitude: Number(place.lon),
      source: 'nominatim',
    })) });
  }
  if (route === '/api/places/reverse' && method === 'GET') {
    const latitude = url.searchParams.get('latitude');
    const longitude = url.searchParams.get('longitude');
    const place = await fetchNominatim(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
      lat: latitude ?? '',
      lon: longitude ?? '',
      format: 'jsonv2',
    })}`);
    return jsonResponse({ label: place.display_name });
  }

  throw new Error(`SUPABASE_ENDPOINT_NOT_MIGRATED:${route}`);
}

export async function supabaseApiFetch(path, options) {
  try {
    return await handle(path, options);
  } catch (error) {
    return fail(error);
  }
}
