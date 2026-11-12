import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createBrevoEmailSender } from './email/brevo.mjs';
import {
  createSQLitePersistence,
  openDatabase,
  openPostgresDatabase,
} from './db/index.mjs';

const scrypt = promisify(scryptCallback);
const passwordParameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummyPasswordHash = 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10';
const termsVersion = '2026-11-05';

export async function createApp({
  databasePath,
  databaseUrl = process.env.DATABASE_URL,
  uploadsDirectory = process.env.UPLOADS_DIRECTORY ?? './server/data/profile-photos',
  logger = true,
  jwtSecret = process.env.JWT_SECRET,
  clientOrigin = process.env.CLIENT_ORIGIN,
  environment = process.env.NODE_ENV ?? 'development',
  fetchImpl = globalThis.fetch,
  emailSender = createBrevoEmailSender({
    apiKey: process.env.BREVO_API_KEY,
    senderEmail: process.env.BREVO_SENDER_EMAIL,
    senderName: process.env.BREVO_SENDER_NAME ?? 'DriveNight',
    fetchImpl,
  }),
  emailDeliveryEnabled = process.env.EMAIL_DELIVERY_ENABLED === 'true',
  clock = () => Date.now(),
} = {}) {
  const database = databaseUrl
    ? await openPostgresDatabase(databaseUrl)
    : createSQLitePersistence(openDatabase(databasePath));
  const app = Fastify({ logger });
  let allowedClientOrigin = null;
  if (clientOrigin) {
    let parsedClientOrigin;
    try {
      parsedClientOrigin = new URL(clientOrigin);
    } catch {
      await database.close();
      throw new Error('CLIENT_ORIGIN doit être une origine HTTP ou HTTPS valide.');
    }

    const isLocalHttpOrigin = parsedClientOrigin.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(parsedClientOrigin.hostname);
    if (
      !['https:', 'http:'].includes(parsedClientOrigin.protocol)
      || (parsedClientOrigin.protocol !== 'https:' && !isLocalHttpOrigin)
      || parsedClientOrigin.username
      || parsedClientOrigin.password
      || parsedClientOrigin.pathname !== '/'
      || parsedClientOrigin.search
      || parsedClientOrigin.hash
    ) {
      await database.close();
      throw new Error('CLIENT_ORIGIN doit contenir uniquement l’origine HTTPS du client.');
    }
    allowedClientOrigin = parsedClientOrigin.origin;
  }

  const resolvedUploadsDirectory = resolve(uploadsDirectory);
  const phoneChangeChallenges = new Map();
  const placeSearchCache = new Map();
  const reversePlaceCache = new Map();
  const realtimeTickets = new Map();
  const realtimeClients = new Map();
  const accountPresence = new Map();
  let lastNominatimRequestAt = 0;
  let nominatimQueue = Promise.resolve();
  const otpLifetimeMs = 5 * 60 * 1000;
  const signingSecret = jwtSecret ?? 'drivenight-local-only-jwt-secret-change-before-production';
  const emailOtpWindowMs = 60 * 60 * 1000;
  const maxEmailOtpSendsPerHour = 3;

  function hashChallengeOtp(challengeId, otp) {
    return createHmac('sha256', signingSecret).update(`${challengeId}:${otp}`).digest('hex');
  }

  async function reserveEmailOtp(email, now) {
    const emailHash = createHmac('sha256', signingSecret).update(email).digest('hex');
    await database.transaction(async () => {
      await database.prepare(
        'DELETE FROM email_otp_rate_limits WHERE window_started_at_ms <= ?',
      ).run(now - emailOtpWindowMs);
      const { send_count: sendCount } = await database.prepare(`
        INSERT INTO email_otp_rate_limits (
          email_hash, window_started_at_ms, send_count
        ) VALUES (?, ?, 1)
        ON CONFLICT (email_hash) DO UPDATE SET
          send_count = CASE
            WHEN email_otp_rate_limits.window_started_at_ms <= ? THEN 1
            ELSE email_otp_rate_limits.send_count + 1
          END,
          window_started_at_ms = CASE
            WHEN email_otp_rate_limits.window_started_at_ms <= ?
              THEN excluded.window_started_at_ms
            ELSE email_otp_rate_limits.window_started_at_ms
          END
        RETURNING send_count
      `).get(emailHash, now, now - emailOtpWindowMs, now - emailOtpWindowMs);
      if (sendCount > maxEmailOtpSendsPerHour) {
        const error = new Error('EMAIL_OTP_RATE_LIMIT');
        error.code = 'EMAIL_OTP_RATE_LIMIT';
        throw error;
      }
    })();
  }

  async function saveEmailChallenge({ id, flow, userId = null, email, otp, payload, now }) {
    await database.transaction(async () => {
      await database.prepare(
        'DELETE FROM email_challenges WHERE expires_at_ms <= ?',
      ).run(now);
      if (userId === null) {
        await database.prepare(`
          DELETE FROM email_challenges
          WHERE flow = ? AND email = ? AND user_id IS NULL
        `).run(flow, email);
      } else {
        await database.prepare(`
          DELETE FROM email_challenges
          WHERE flow = ? AND email = ? AND user_id = ?
        `).run(flow, email, userId);
      }
      await database.prepare(`
        INSERT INTO email_challenges (
          id, flow, user_id, email, otp_hash, payload_json, expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        flow,
        userId,
        email,
        hashChallengeOtp(id, otp),
        payload === null ? null : JSON.stringify(payload),
        now + otpLifetimeMs,
        now,
      );
    })();
  }

  async function sendEmailChallenge(request, reply, { email, otp, purpose }) {
    if (!emailDeliveryEnabled && environment !== 'production') return 'email-simulated';
    if (!emailDeliveryEnabled || !emailSender) {
      reply.code(503).send({ error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
      return null;
    }

    try {
      await emailSender({ to: email, code: otp, purpose });
      return 'email';
    } catch (error) {
      request.log.error({
        code: error.code ?? 'EMAIL_PROVIDER_ERROR',
        status: error.status,
      }, 'Verification email could not be sent');
      reply.code(503).send({ error: 'EMAIL_DELIVERY_FAILED' });
      return null;
    }
  }

  async function verifyEmailChallenge({ id, flow, userId = null, otp, now }) {
    return database.transaction(async () => {
      const ownerCondition = userId === null ? 'user_id IS NULL' : 'user_id = ?';
      const ownerParameters = userId === null ? [] : [userId];
      const otpHash = hashChallengeOtp(id, otp);
      const challenge = await database.prepare(`
        DELETE FROM email_challenges
        WHERE id = ? AND flow = ? AND ${ownerCondition}
          AND expires_at_ms > ? AND attempts < 5 AND otp_hash = ?
        RETURNING *
      `).get(id, flow, ...ownerParameters, now, otpHash);
      if (challenge) return challenge;

      const expired = await database.prepare(`
        DELETE FROM email_challenges
        WHERE id = ? AND flow = ? AND ${ownerCondition} AND expires_at_ms <= ?
      `).run(id, flow, ...ownerParameters, now);
      if (expired.changes) return null;

      await database.prepare(`
        UPDATE email_challenges
        SET attempts = attempts + 1
        WHERE id = ? AND flow = ? AND ${ownerCondition}
          AND expires_at_ms > ? AND attempts < 5 AND otp_hash <> ?
        RETURNING attempts
      `).get(id, flow, ...ownerParameters, now, otpHash);
      await database.prepare(`
        DELETE FROM email_challenges
        WHERE id = ? AND flow = ? AND ${ownerCondition} AND attempts >= 5
      `).run(id, flow, ...ownerParameters);
      return null;
    })();
  }

  async function expireTimedOffers() {
    const now = new Date(clock()).toISOString();
    const expiredRideIds = (await database.prepare(`
      SELECT DISTINCT ride_id
      FROM ride_offers
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(now)).map(({ ride_id }) => ride_id);
    if (!expiredRideIds.length) return;

    await database.prepare(`
      UPDATE ride_offers
      SET status = 'withdrawn', responded_at = ?
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, now);
    for (const rideId of expiredRideIds) {
      publishRealtimeEvent(realtimeClients, rideId, {
        type: 'offers.updated',
        rideId,
      });
    }
  }

  if (environment === 'production' && !jwtSecret) {
    await database.close();
    throw new Error('JWT_SECRET est obligatoire en production.');
  }

  await app.register(jwt, { secret: signingSecret });
  if (allowedClientOrigin) {
    await app.register(cors, {
      origin: (origin, callback) => {
        callback(null, origin === allowedClientOrigin ? allowedClientOrigin : false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400,
    });
  }
  await app.register(websocket);

  app.addHook('onClose', async () => {
    await database.close();
  });

  app.get('/api/health', async (request, reply) => {
    try {
      await database.prepare('SELECT 1').get();
      return { status: 'ok', database: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'Database health check failed');
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });

  app.post('/api/presence', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    accountPresence.set(user.id, Date.now());
    return reply.code(204).send();
  });

  app.post('/api/realtime/ticket', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const now = Date.now();
    for (const [ticket, record] of realtimeTickets) {
      if (record.expiresAt <= now) realtimeTickets.delete(ticket);
    }
    const ticket = randomBytes(32).toString('base64url');
    realtimeTickets.set(ticket, {
      userId: user.id,
      expiresAt: now + 30_000,
    });
    return reply.code(201).send({ ticket, expiresInSeconds: 30 });
  });

  app.get('/api/realtime', {
    websocket: true,
    schema: {
      querystring: {
        type: 'object',
        required: ['ticket'],
        properties: { ticket: { type: 'string', minLength: 40, maxLength: 64 } },
      },
    },
    preValidation: async (request, reply) => {
      const ticket = request.query.ticket;
      const record = realtimeTickets.get(ticket);
      if (record) realtimeTickets.delete(ticket);
      if (!record || record.expiresAt <= Date.now()) {
        return reply.code(401).send({ error: 'REALTIME_TICKET_INVALID' });
      }

      const user = await database.prepare(
        'SELECT id FROM users WHERE id = ? AND is_active = 1',
      ).get(record.userId);
      if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      request.realtimeUserId = user.id;
    },
  }, (socket, request) => {
    const client = { userId: request.realtimeUserId, rideIds: new Set() };
    realtimeClients.set(socket, client);
    socket.on('message', async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'MESSAGE_INVALID' }));
        return;
      }
      if (message?.type !== 'subscribe' || typeof message.rideId !== 'string') {
        socket.send(JSON.stringify({ type: 'error', error: 'MESSAGE_INVALID' }));
        return;
      }

      if (!await canSubscribeToRide(database, client.userId, message.rideId)) {
        socket.send(JSON.stringify({
          type: 'error',
          rideId: message.rideId,
          error: 'RIDE_PARTICIPANT_REQUIRED',
        }));
        return;
      }

      client.rideIds.add(message.rideId);
      socket.send(JSON.stringify({ type: 'subscribed', rideId: message.rideId }));
      const location = await database.prepare(`
        SELECT ride_locations.latitude, ride_locations.longitude,
          ride_locations.updated_at, rides.passenger_id, rides.driver_id
        FROM ride_locations
        JOIN rides ON rides.id = ride_locations.ride_id
        WHERE ride_locations.ride_id = ?
          AND rides.status IN ('driver_en_route', 'driver_arrived', 'in_progress')
      `).get(message.rideId);
      if (location && (client.userId === location.passenger_id || client.userId === location.driver_id)) {
        socket.send(JSON.stringify({
          type: 'ride.location.updated',
          rideId: message.rideId,
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
            updatedAt: location.updated_at,
          },
        }));
      }
    });
    socket.on('close', () => realtimeClients.delete(socket));
    socket.on('error', () => realtimeClients.delete(socket));
  });

  app.post('/api/auth/otp/request', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['flow', 'name', 'email', 'phone', 'role', 'password', 'termsAccepted'],
        properties: {
          flow: { type: 'string', enum: ['signup'] },
          name: { type: 'string', minLength: 2, maxLength: 80 },
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          email: { type: 'string', minLength: 3, maxLength: 254 },
          role: { type: 'string', enum: ['passenger', 'driver'] },
          password: { type: 'string', minLength: 10, maxLength: 128 },
          termsAccepted: { type: 'boolean' },
          vehicleCategory: { type: 'string', enum: ['moto', 'voiture'] },
          vehicleRegistration: { type: 'string', minLength: 2, maxLength: 20 },
          profilePhoto: { type: 'string', maxLength: 700_000 },
        },
      },
    },
  }, async (request, reply) => {
    if ((environment === 'production' || emailDeliveryEnabled)
      && (!emailDeliveryEnabled || !emailSender)) {
      return reply.code(503).send({ error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
    }
    if (!request.body.termsAccepted) {
      return reply.code(400).send({ error: 'TERMS_NOT_ACCEPTED' });
    }

    const phone = normalizePhone(request.body.phone);
    if (!phone) return reply.code(400).send({ error: 'PHONE_INVALID' });
    const name = request.body.name.trim();
    if (name.length < 2) return reply.code(400).send({ error: 'NAME_REQUIRED' });
    let vehicleCategory = null;
    let vehicleRegistration = null;
    let profilePhoto = null;
    if (request.body.role === 'driver') {
      vehicleCategory = request.body.vehicleCategory;
      vehicleRegistration = normalizeVehicleRegistration(request.body.vehicleRegistration ?? '');
      if (!vehicleCategory || !vehicleRegistration) {
        return reply.code(400).send({ error: 'DRIVER_VEHICLE_REQUIRED' });
      }
      const existingVehicle = await database.prepare(
        'SELECT user_id FROM driver_profiles WHERE upper(vehicle_registration) = ?',
      ).get(vehicleRegistration);
      if (existingVehicle) return reply.code(409).send({ error: 'VEHICLE_ALREADY_EXISTS' });

      if (request.body.profilePhoto) {
        try {
          profilePhoto = decodeProfilePhoto(request.body.profilePhoto);
        } catch (error) {
          return reply.code(400).send({ error: error.message });
        }
      }
    } else if (request.body.profilePhoto) {
      return reply.code(400).send({ error: 'PROFILE_PHOTO_DRIVER_ONLY' });
    }

    const email = normalizeEmail(request.body.email);
    if (!email) return reply.code(400).send({ error: 'EMAIL_INVALID' });
    const existing = await database.prepare(
      'SELECT id FROM users WHERE phone = ? OR email = ?',
    ).get(phone, email);
    if (existing) return reply.code(409).send({ error: 'ACCOUNT_ALREADY_EXISTS' });
    const now = clock();
    try {
      await reserveEmailOtp(email, now);
    } catch (error) {
      if (error.code === 'EMAIL_OTP_RATE_LIMIT') {
        return reply.code(429).send({ error: 'EMAIL_RATE_LIMITED' });
      }
      throw error;
    }
    const passwordHash = await hashPassword(request.body.password);

    const challengeId = randomUUID();
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const signupPayload = {
      phone,
      email,
      role: request.body.role,
      name,
      passwordHash,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion,
      vehicleCategory,
      vehicleRegistration,
      profilePhotoBase64: profilePhoto?.toString('base64') ?? null,
    };
    await saveEmailChallenge({
      id: challengeId,
      flow: 'signup',
      email,
      otp,
      payload: signupPayload,
      now,
    });

    const delivery = await sendEmailChallenge(request, reply, {
      email,
      otp,
      purpose: 'signup',
    });
    if (!delivery) {
      await database.prepare('DELETE FROM email_challenges WHERE id = ?').run(challengeId);
      return reply;
    }
    return {
      challengeId,
      expiresInSeconds: otpLifetimeMs / 1000,
      ...(delivery === 'email-simulated' ? { otp } : {}),
      delivery,
      recipient: maskEmail(email),
    };
  });

  app.post('/api/auth/register', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'phone', 'role', 'password', 'termsAccepted'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 80 },
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          role: { type: 'string', enum: ['passenger', 'driver'] },
          password: { type: 'string', minLength: 10, maxLength: 128 },
          termsAccepted: { type: 'boolean' },
          vehicleCategory: { type: 'string', enum: ['moto', 'voiture'] },
          vehicleRegistration: { type: 'string', minLength: 2, maxLength: 20 },
          profilePhoto: { type: 'string', maxLength: 700_000 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.body.termsAccepted) {
      return reply.code(400).send({ error: 'TERMS_NOT_ACCEPTED' });
    }

    const phone = normalizePhone(request.body.phone);
    if (!phone) return reply.code(400).send({ error: 'PHONE_INVALID' });
    const name = request.body.name.trim();
    if (name.length < 2) return reply.code(400).send({ error: 'NAME_REQUIRED' });
    const existingAccount = await database.prepare(
      'SELECT id FROM users WHERE phone = ?',
    ).get(phone);
    if (existingAccount) return reply.code(409).send({ error: 'ACCOUNT_ALREADY_EXISTS' });

    let vehicleCategory = null;
    let vehicleRegistration = null;
    if (request.body.role === 'driver') {
      vehicleCategory = request.body.vehicleCategory;
      vehicleRegistration = normalizeVehicleRegistration(request.body.vehicleRegistration ?? '');
      if (!vehicleCategory || !vehicleRegistration) {
        return reply.code(400).send({ error: 'DRIVER_VEHICLE_REQUIRED' });
      }
      const existingVehicle = await database.prepare(
        'SELECT user_id FROM driver_profiles WHERE upper(vehicle_registration) = ?',
      ).get(vehicleRegistration);
      if (existingVehicle) return reply.code(409).send({ error: 'VEHICLE_ALREADY_EXISTS' });
    } else if (request.body.profilePhoto) {
      return reply.code(400).send({ error: 'PROFILE_PHOTO_DRIVER_ONLY' });
    }

    let profilePhoto = null;
    if (request.body.profilePhoto) {
      try {
        profilePhoto = decodeProfilePhoto(request.body.profilePhoto);
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }

    const userId = randomUUID();
    const photoFilename = profilePhoto ? `${randomUUID()}.jpg` : null;
    const photoUrl = photoFilename ? `/api/media/${photoFilename}` : null;
    const photoPath = photoFilename ? join(resolvedUploadsDirectory, photoFilename) : null;
    if (photoPath) {
      await mkdir(resolvedUploadsDirectory, { recursive: true });
      await writeFile(photoPath, profilePhoto, { flag: 'wx' });
    }

    try {
      await database.transaction(async () => {
        await database.prepare(`
          INSERT INTO users (
            id, phone, email, email_verified_at, role, name, password_hash,
            terms_accepted_at, terms_version, photo_url
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        `).run(
          userId,
          phone,
          request.body.role,
          name,
          await hashPassword(request.body.password),
          termsVersion,
          photoUrl,
        );
        if (request.body.role === 'driver') {
          const vehicleId = randomUUID();
          await database.prepare(`
            INSERT INTO driver_profiles (
              user_id, validation_status, vehicle_category, vehicle_make, vehicle_model,
              vehicle_color, vehicle_registration
            ) VALUES (?, 'approved', ?, NULL, NULL, NULL, ?)
          `).run(userId, vehicleCategory, vehicleRegistration);
          await database.prepare(`
            INSERT INTO driver_vehicles (
              id, user_id, category, vehicle_registration
            ) VALUES (?, ?, ?, ?)
          `).run(vehicleId, userId, vehicleCategory, vehicleRegistration);
          await database.prepare(`
            UPDATE driver_profiles SET active_vehicle_id = ? WHERE user_id = ?
          `).run(vehicleId, userId);
        }
      })();
    } catch (error) {
      if (photoPath) {
        try {
          await rm(photoPath, { force: true });
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, photoPath }, 'Could not remove an unclaimed profile photo');
        }
      }
      if (isUniqueConstraintError(error)) {
        const duplicatePhone = await database.prepare(
          'SELECT id FROM users WHERE phone = ?',
        ).get(phone);
        return reply.code(409).send({
          error: duplicatePhone ? 'ACCOUNT_ALREADY_EXISTS' : 'VEHICLE_ALREADY_EXISTS',
        });
      }
      throw error;
    }

    const user = await getProfileRecord(database, userId);
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
    return reply.code(201).send({ token, user: toPublicProfile(user) });
  });

  app.post('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['password'],
        properties: {
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          identifier: { type: 'string', minLength: 1, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
        oneOf: [
          { required: ['phone'] },
          { required: ['identifier'] },
        ],
      },
    },
  }, async (request, reply) => {
    const identifier = (request.body.phone ?? request.body.identifier).trim();
    const password = request.body.password;
    const phone = normalizePhone(identifier);
    if (request.body.phone && !phone) {
      return reply.code(400).send({ error: 'PHONE_INVALID' });
    }
    const matches = phone
      ? await database.prepare('SELECT * FROM users WHERE phone = ? LIMIT 2').all(phone)
      : identifier.includes('@')
      ? await database.prepare('SELECT * FROM users WHERE lower(email) = ? LIMIT 2').all(identifier.toLowerCase())
        : await database.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE LIMIT 2').all(identifier);
    const user = matches.length === 1 ? matches[0] : null;
    const validPassword = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash);
    if (!user || !validPassword || !user.is_active) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
    return { token, user: toPublicProfile(await getProfileRecord(database, user.id)) };
  });

  app.post('/api/auth/otp/verify', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['challengeId', 'otp'],
        properties: {
          challengeId: { type: 'string', minLength: 1, maxLength: 64 },
          otp: { type: 'string', pattern: '^\\d{6}$' },
        },
      },
    },
  }, async (request, reply) => {
    const challenge = await verifyEmailChallenge({
      id: request.body.challengeId,
      flow: 'signup',
      otp: request.body.otp,
      now: clock(),
    });
    if (!challenge?.payload_json) {
      return reply.code(400).send({ error: 'OTP_EXPIRED_OR_INVALID' });
    }

    const signup = JSON.parse(challenge.payload_json);
    const existing = await database.prepare(
      'SELECT id FROM users WHERE phone = ? OR email = ?',
    ).get(signup.phone, signup.email);
    if (existing) {
      await database.prepare('DELETE FROM email_challenges WHERE id = ?').run(challenge.id);
      return reply.code(409).send({ error: 'ACCOUNT_ALREADY_EXISTS' });
    }

    const userId = randomUUID();
    const profilePhoto = signup.profilePhotoBase64
      ? Buffer.from(signup.profilePhotoBase64, 'base64')
      : null;
    const photoFilename = profilePhoto ? `${randomUUID()}.jpg` : null;
    const photoUrl = photoFilename ? `/api/media/${photoFilename}` : null;
    const photoPath = photoFilename ? join(resolvedUploadsDirectory, photoFilename) : null;
    if (photoPath) {
      await mkdir(resolvedUploadsDirectory, { recursive: true });
      await writeFile(photoPath, profilePhoto, { flag: 'wx' });
    }

    try {
      await database.transaction(async () => {
        await database.prepare(`
          INSERT INTO users (
            id, phone, email, email_verified_at, role, name, password_hash,
            terms_accepted_at, terms_version, photo_url
          ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          signup.phone,
          signup.email,
          signup.role,
          signup.name,
          signup.passwordHash,
          signup.termsAcceptedAt,
          signup.termsVersion,
          photoUrl,
        );
        if (signup.role === 'driver') {
          const vehicleId = randomUUID();
          await database.prepare(`
            INSERT INTO driver_profiles (
              user_id, validation_status, vehicle_category, vehicle_make, vehicle_model,
              vehicle_color, vehicle_registration
            ) VALUES (?, 'approved', ?, NULL, NULL, NULL, ?)
          `).run(userId, signup.vehicleCategory, signup.vehicleRegistration);
          await database.prepare(`
            INSERT INTO driver_vehicles (
              id, user_id, category, vehicle_registration
            ) VALUES (?, ?, ?, ?)
          `).run(vehicleId, userId, signup.vehicleCategory, signup.vehicleRegistration);
          await database.prepare(`
            UPDATE driver_profiles
            SET active_vehicle_id = ?
            WHERE user_id = ?
          `).run(vehicleId, userId);
        }
      })();
    } catch (error) {
      if (photoPath) {
        try {
          await rm(photoPath, { force: true });
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, photoPath }, 'Could not remove an unclaimed profile photo');
        }
      }
      if (isUniqueConstraintError(error) && signup.role === 'driver') {
        return reply.code(409).send({ error: 'VEHICLE_ALREADY_EXISTS' });
      }
      throw error;
    }
    const user = await getProfileRecord(database, userId);

    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
    return { token, user: toPublicProfile(user) };
  });

  app.get('/api/media/:fileName', async (request, reply) => {
    const { fileName } = request.params;
    if (!/^[0-9a-f-]{36}\.jpg$/.test(fileName)) {
      return reply.code(404).send({ error: 'MEDIA_NOT_FOUND' });
    }
    try {
      const image = await readFile(join(resolvedUploadsDirectory, fileName));
      return reply
        .type('image/jpeg')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(image);
    } catch (error) {
      if (error.code === 'ENOENT') return reply.code(404).send({ error: 'MEDIA_NOT_FOUND' });
      throw error;
    }
  });

  app.post('/api/rides', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['origin', 'destination', 'category', 'proposedPriceMGA'],
        properties: {
          origin: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'latitude', 'longitude'],
            properties: {
              label: { type: 'string', minLength: 2, maxLength: 200 },
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
            },
          },
          destination: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'latitude', 'longitude'],
            properties: {
              label: { type: 'string', minLength: 2, maxLength: 200 },
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
            },
          },
          category: { type: 'string', enum: ['moto', 'taxi', 'voiture'] },
          proposedPriceMGA: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const passenger = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!passenger) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (passenger.role !== 'passenger') return reply.code(403).send({ error: 'PASSENGER_REQUIRED' });

    const { origin, destination, category, proposedPriceMGA } = request.body;
    const originLabel = origin.label.trim();
    const destinationLabel = destination.label.trim();
    if (originLabel.length < 2 || destinationLabel.length < 2) {
      return reply.code(400).send({ error: 'PLACE_LABEL_REQUIRED' });
    }
    if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) {
      return reply.code(400).send({ error: 'ROUTE_POINTS_MUST_DIFFER' });
    }

    const rideId = randomUUID();
    const offerId = randomUUID();
    const createRide = database.transaction(async () => {
      await database.prepare(`
        INSERT INTO rides (
          id, passenger_id, origin_label, origin_latitude, origin_longitude,
          destination_label, destination_latitude, destination_longitude,
          category, proposed_price_mga, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'searching')
      `).run(
        rideId,
        passenger.id,
        originLabel,
        origin.latitude,
        origin.longitude,
        destinationLabel,
        destination.latitude,
        destination.longitude,
        category,
        proposedPriceMGA,
      );
      await database.prepare(`
        INSERT INTO ride_offers (id, ride_id, proposer_id, amount_mga)
        VALUES (?, ?, ?, ?)
      `).run(offerId, rideId, passenger.id, proposedPriceMGA);
    });
    await createRide();
    await publishRideAvailability(realtimeClients, database, { id: rideId, category });

    const ride = await database.prepare(`
      SELECT id, passenger_id, origin_label, origin_latitude, origin_longitude,
        destination_label, destination_latitude, destination_longitude,
        category, proposed_price_mga, status, requested_at,
        (SELECT id FROM ride_offers
          WHERE ride_id = rides.id AND proposer_id = rides.passenger_id
          ORDER BY created_at, id LIMIT 1) AS initial_offer_id
      FROM rides WHERE id = ?
    `).get(rideId);
    return reply.code(201).send({ ride: toPublicRide(ride) });
  });

  app.get('/api/rides/history', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (!['passenger', 'driver'].includes(account.role)) {
      return reply.code(403).send({ error: 'RIDE_HISTORY_UNAVAILABLE' });
    }

    const rideColumn = account.role === 'passenger' ? 'passenger_id' : 'driver_id';
    const rides = await database.prepare(`
      SELECT rides.id, rides.passenger_id, rides.driver_id,
        rides.origin_label, rides.origin_latitude, rides.origin_longitude,
        rides.destination_label, rides.destination_latitude, rides.destination_longitude,
        rides.category, rides.proposed_price_mga, rides.agreed_price_mga,
        rides.status, rides.requested_at, rides.accepted_at, rides.completed_at,
        rides.cancelled_at,
        passengers.name AS passenger_name, passengers.photo_url AS passenger_photo_url,
        drivers.name AS driver_name, drivers.photo_url AS driver_photo_url,
        own_ratings.stars AS own_rating_stars,
        own_ratings.comment AS own_rating_comment,
        own_ratings.created_at AS own_rating_created_at
      FROM rides
      JOIN users AS passengers ON passengers.id = rides.passenger_id
      LEFT JOIN users AS drivers ON drivers.id = rides.driver_id
      LEFT JOIN ratings AS own_ratings
        ON own_ratings.ride_id = rides.id AND own_ratings.rater_id = ?
      WHERE rides.${rideColumn} = ?
      ORDER BY COALESCE(rides.completed_at, rides.cancelled_at, rides.accepted_at,
        rides.requested_at, rides.created_at) DESC, rides.id DESC
    `).all(account.id, account.id);

    return {
      rides: rides.map((ride) => ({
        ...toPublicRide(ride),
        completedAt: ride.completed_at ?? null,
        cancelledAt: ride.cancelled_at ?? null,
        myRating: ride.own_rating_stars === null || ride.own_rating_stars === undefined
          ? null
          : {
              stars: ride.own_rating_stars,
              comment: ride.own_rating_comment,
              createdAt: ride.own_rating_created_at,
            },
        counterparty: account.role === 'passenger'
          ? (ride.driver_id ? {
              id: ride.driver_id,
              name: ride.driver_name,
              photoUrl: ride.driver_photo_url,
            } : null)
          : {
              id: ride.passenger_id,
              name: ride.passenger_name,
              photoUrl: ride.passenger_photo_url,
            },
      })),
    };
  });

  app.patch('/api/account/profile', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 80 },
          profilePhoto: { anyOf: [{ type: 'string', maxLength: 700_000 }, { type: 'null' }] },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id, name, photo_url FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const name = request.body.name?.trim();
    if (name !== undefined && name.length < 2) {
      return reply.code(400).send({ error: 'NAME_REQUIRED' });
    }

    let photoUrl = user.photo_url;
    let photoPath = null;
    if (Object.hasOwn(request.body, 'profilePhoto')) {
      if (request.body.profilePhoto === null) {
        photoUrl = null;
      } else {
        let photo;
        try {
          photo = decodeProfilePhoto(request.body.profilePhoto);
        } catch (error) {
          return reply.code(400).send({ error: error.message });
        }
        const fileName = `${randomUUID()}.jpg`;
        photoUrl = `/api/media/${fileName}`;
        photoPath = join(resolvedUploadsDirectory, fileName);
        await mkdir(resolvedUploadsDirectory, { recursive: true });
        await writeFile(photoPath, photo, { flag: 'wx' });
      }
    }

    try {
      await database.prepare(`
        UPDATE users
        SET name = ?, photo_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name ?? user.name, photoUrl, user.id);
    } catch (error) {
      if (photoPath) {
        try {
          await rm(photoPath, { force: true });
        } catch (cleanupError) {
          request.log.error({ err: cleanupError }, 'Could not remove an unclaimed profile photo');
        }
      }
      throw error;
    }

    if (user.photo_url && user.photo_url !== photoUrl) {
      const oldFileName = user.photo_url.split('/').at(-1);
      if (/^[0-9a-f-]{36}\.jpg$/.test(oldFileName)) {
        try {
          await rm(join(resolvedUploadsDirectory, oldFileName), { force: true });
        } catch (error) {
          request.log.error({ err: error }, 'Could not remove the previous profile photo');
        }
      }
    }
    return { profile: toPublicProfile(await getProfileRecord(database, user.id)) };
  });

  app.patch('/api/account/profile/password', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
          newPassword: { type: 'string', minLength: 10, maxLength: 128 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id, role, password_hash FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (!await verifyPassword(request.body.currentPassword, user.password_hash)) {
      return reply.code(400).send({ error: 'CURRENT_PASSWORD_INVALID' });
    }

    const passwordHash = await hashPassword(request.body.newPassword);
    await database.prepare(`
      UPDATE users
      SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(passwordHash, user.id);
    return { changed: true };
  });

  app.post('/api/account/profile/email/request', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['email'],
        properties: { email: { type: 'string', minLength: 3, maxLength: 254 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if ((environment === 'production' || emailDeliveryEnabled)
      && (!emailDeliveryEnabled || !emailSender)) {
      return reply.code(503).send({ error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
    }
    const email = normalizeEmail(request.body.email);
    if (!email) return reply.code(400).send({ error: 'EMAIL_INVALID' });
    const existing = await database.prepare(
      'SELECT id FROM users WHERE lower(email) = ? AND id <> ?',
    ).get(email, user.id);
    if (existing) return reply.code(409).send({ error: 'EMAIL_ALREADY_IN_USE' });

    const now = clock();
    try {
      await reserveEmailOtp(email, now);
    } catch (error) {
      if (error.code === 'EMAIL_OTP_RATE_LIMIT') {
        return reply.code(429).send({ error: 'EMAIL_RATE_LIMITED' });
      }
      throw error;
    }

    const challengeId = randomUUID();
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await saveEmailChallenge({
      id: challengeId,
      flow: 'email-change',
      userId: user.id,
      email,
      otp,
      payload: null,
      now,
    });

    const delivery = await sendEmailChallenge(request, reply, {
      email,
      otp,
      purpose: 'email-change',
    });
    if (!delivery) {
      await database.prepare('DELETE FROM email_challenges WHERE id = ?').run(challengeId);
      return reply;
    }
    return {
      challengeId,
      expiresInSeconds: otpLifetimeMs / 1000,
      ...(delivery === 'email-simulated' ? { otp } : {}),
      delivery,
      recipient: maskEmail(email),
    };
  });

  app.post('/api/account/profile/email/verify', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['challengeId', 'otp'],
        properties: {
          challengeId: { type: 'string', minLength: 1, maxLength: 64 },
          otp: { type: 'string', pattern: '^\\d{6}$' },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const challenge = await verifyEmailChallenge({
      id: request.body.challengeId,
      flow: 'email-change',
      userId: user.id,
      otp: request.body.otp,
      now: clock(),
    });
    if (!challenge) {
      return reply.code(400).send({ error: 'OTP_EXPIRED_OR_INVALID' });
    }
    const existing = await database.prepare(
      'SELECT id FROM users WHERE lower(email) = ? AND id <> ?',
    ).get(challenge.email, user.id);
    if (existing) {
      return reply.code(409).send({ error: 'EMAIL_ALREADY_IN_USE' });
    }
    await database.transaction(async () => {
      await database.prepare(`
        UPDATE users
        SET email = ?, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(challenge.email, user.id);
    })();
    return { profile: toPublicProfile(await getProfileRecord(database, user.id)) };
  });

  app.post('/api/account/profile/phone/request', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['phone'],
        properties: { phone: { type: 'string', minLength: 8, maxLength: 20 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id, phone FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (environment === 'production') {
      return reply.code(503).send({ error: 'OTP_SIMULATION_DISABLED' });
    }

    const phone = normalizePhone(request.body.phone);
    if (!phone) return reply.code(400).send({ error: 'PHONE_INVALID' });
    if (phone === user.phone) return reply.code(400).send({ error: 'PHONE_UNCHANGED' });
    const existing = await database.prepare(
      'SELECT id FROM users WHERE phone = ? AND id <> ?',
    ).get(phone, user.id);
    if (existing) return reply.code(409).send({ error: 'PHONE_ALREADY_IN_USE' });

    const challengeId = randomUUID();
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    phoneChangeChallenges.set(challengeId, {
      userId: user.id,
      phone,
      otp,
      attempts: 0,
      expiresAt: clock() + otpLifetimeMs,
    });
    return {
      challengeId,
      expiresInSeconds: otpLifetimeMs / 1000,
      otp,
      delivery: 'sms-simulated',
      recipient: maskPhone(phone),
    };
  });

  app.post('/api/account/profile/phone/verify', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['challengeId', 'otp'],
        properties: {
          challengeId: { type: 'string', minLength: 1, maxLength: 64 },
          otp: { type: 'string', pattern: '^\\d{6}$' },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT id FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const challenge = phoneChangeChallenges.get(request.body.challengeId);
    if (!challenge || challenge.userId !== user.id || challenge.expiresAt <= clock()) {
      phoneChangeChallenges.delete(request.body.challengeId);
      return reply.code(400).send({ error: 'OTP_EXPIRED_OR_INVALID' });
    }
    challenge.attempts += 1;
    if (challenge.attempts > 5 || challenge.otp !== request.body.otp) {
      if (challenge.attempts >= 5) phoneChangeChallenges.delete(request.body.challengeId);
      return reply.code(400).send({ error: 'OTP_EXPIRED_OR_INVALID' });
    }
    const existing = await database.prepare(
      'SELECT id FROM users WHERE phone = ? AND id <> ?',
    ).get(challenge.phone, user.id);
    if (existing) {
      phoneChangeChallenges.delete(request.body.challengeId);
      return reply.code(409).send({ error: 'PHONE_ALREADY_IN_USE' });
    }
    await database.prepare(`
      UPDATE users
      SET phone = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(challenge.phone, user.id);
    phoneChangeChallenges.delete(request.body.challengeId);
    return { profile: toPublicProfile(await getProfileRecord(database, user.id)) };
  });

  app.post('/api/driver/vehicles', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'vehicleRegistration'],
        properties: {
          category: { type: 'string', enum: ['moto', 'voiture'] },
          vehicleRegistration: { type: 'string', minLength: 2, maxLength: 20 },
          vehicleMake: { type: 'string', maxLength: 50 },
          vehicleModel: { type: 'string', maxLength: 50 },
          vehicleColor: { type: 'string', maxLength: 40 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const driver = await database.prepare(`
      SELECT users.id, users.role
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.is_active = 1
    `).get(request.user.sub);
    if (!driver || driver.role !== 'driver') return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    if (await database.prepare('SELECT 1 FROM driver_vehicles WHERE user_id = ?')
      .get(driver.id)) {
      return reply.code(409).send({ error: 'VEHICLE_LIMIT_REACHED' });
    }

    const registration = normalizeVehicleRegistration(request.body.vehicleRegistration);
    if (!registration) return reply.code(400).send({ error: 'VEHICLE_REGISTRATION_INVALID' });
    if (await database.prepare('SELECT 1 FROM driver_vehicles WHERE upper(vehicle_registration) = ?')
      .get(registration)) {
      return reply.code(409).send({ error: 'VEHICLE_ALREADY_EXISTS' });
    }

    const vehicleId = randomUUID();
    try {
      await database.prepare(`
        INSERT INTO driver_vehicles (
          id, user_id, category, vehicle_make, vehicle_model, vehicle_color,
          vehicle_registration
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        vehicleId,
        driver.id,
        request.body.category,
        request.body.vehicleMake?.trim() || null,
        request.body.vehicleModel?.trim() || null,
        request.body.vehicleColor?.trim() || null,
        registration,
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const alreadyHasVehicle = await database.prepare(
          'SELECT 1 FROM driver_vehicles WHERE user_id = ?',
        ).get(driver.id);
        return reply.code(409).send({
          error: alreadyHasVehicle ? 'VEHICLE_LIMIT_REACHED' : 'VEHICLE_ALREADY_EXISTS',
        });
      }
      throw error;
    }
    return reply.code(201).send({
      vehicle: toPublicVehicle(await database.prepare(
        'SELECT * FROM driver_vehicles WHERE id = ?',
      ).get(vehicleId)),
      profile: toPublicProfile(await getProfileRecord(database, driver.id)),
    });
  });

  app.get('/api/admin/summary', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const account = await database.prepare(
      'SELECT role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (account.role !== 'admin') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });

    const users = await database.prepare(`
      SELECT role, is_active, COUNT(*) AS count
      FROM users
      GROUP BY role, is_active
    `).all();
    const rides = await database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM rides
      GROUP BY status
    `).all();
    const userCounts = users.reduce((counts, { role, is_active, count }) => {
      counts[role] ??= { active: 0, inactive: 0 };
      counts[role][is_active ? 'active' : 'inactive'] = count;
      return counts;
    }, {});
    const rideCounts = Object.fromEntries(rides.map(({ status, count }) => [status, count]));
    const activeUsers = users.filter(({ is_active }) => is_active).reduce((total, { count }) => total + count, 0);
    const inactiveUsers = users.filter(({ is_active }) => !is_active).reduce((total, { count }) => total + count, 0);
    return {
      users: {
        total: activeUsers + inactiveUsers,
        active: activeUsers,
        inactive: inactiveUsers,
        passengers: (userCounts.passenger?.active ?? 0) + (userCounts.passenger?.inactive ?? 0),
        drivers: (userCounts.driver?.active ?? 0) + (userCounts.driver?.inactive ?? 0),
        admins: (userCounts.admin?.active ?? 0) + (userCounts.admin?.inactive ?? 0),
      },
      rides: {
        searching: rideCounts.searching ?? 0,
        negotiating: rideCounts.negotiating ?? 0,
        driver_en_route: rideCounts.driver_en_route ?? 0,
        driver_arrived: rideCounts.driver_arrived ?? 0,
        in_progress: rideCounts.in_progress ?? 0,
        completed: rideCounts.completed ?? 0,
        cancelled: rideCounts.cancelled ?? 0,
        total: Object.values(rideCounts).reduce((total, count) => total + count, 0),
      },
    };
  });

  app.get('/api/admin/operations', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const admin = await database.prepare(
      'SELECT role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!admin) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });

    const now = Date.now();
    for (const [userId, lastSeenAt] of accountPresence) {
      if (now - lastSeenAt > 90_000
        || !await database.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1').get(userId)) {
        accountPresence.delete(userId);
      }
    }

    const onlineUsers = await database.prepare(`
      SELECT users.id, users.name, users.role, users.photo_url, users.phone,
        users.average_rating, users.rating_count, driver_profiles.is_online,
        driver_profiles.vehicle_category, driver_profiles.vehicle_registration
      FROM users
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.is_active = 1 AND users.id IN (${[...accountPresence.keys()].map(() => '?').join(',') || "''"})
      ORDER BY users.role, users.name
    `).all(...accountPresence.keys());
    const onlineDrivers = await database.prepare(`
      SELECT users.id, users.name, users.photo_url, users.phone,
        users.average_rating, users.rating_count, driver_profiles.vehicle_category,
        driver_profiles.vehicle_registration,
        CASE WHEN EXISTS (
          SELECT 1 FROM rides
          WHERE rides.driver_id = users.id
            AND rides.status IN ('driver_en_route', 'driver_arrived', 'in_progress')
        ) THEN 0 ELSE 1 END AS is_available
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.role = 'driver' AND users.is_active = 1
        AND driver_profiles.is_online = 1
      ORDER BY is_available DESC, users.name
    `).all();
    const requests = await database.prepare(`
      SELECT rides.id, rides.passenger_id, rides.origin_label, rides.destination_label,
        rides.category, rides.proposed_price_mga, rides.status, rides.requested_at,
        passengers.name AS passenger_name, passengers.phone AS passenger_phone,
        COUNT(ride_offers.id) AS offer_count
      FROM rides
      JOIN users AS passengers ON passengers.id = rides.passenger_id
      LEFT JOIN ride_offers ON ride_offers.ride_id = rides.id
        AND ride_offers.status = 'pending'
      WHERE rides.status IN ('searching', 'negotiating')
      GROUP BY rides.id
      ORDER BY rides.requested_at DESC, rides.id
    `).all();
    const history = await database.prepare(`
      SELECT rides.id, rides.origin_label, rides.destination_label, rides.category,
        rides.proposed_price_mga, rides.agreed_price_mga, rides.status,
        rides.requested_at, rides.accepted_at, rides.completed_at, rides.cancelled_at,
        passengers.name AS passenger_name, drivers.name AS driver_name
      FROM rides
      JOIN users AS passengers ON passengers.id = rides.passenger_id
      LEFT JOIN users AS drivers ON drivers.id = rides.driver_id
      ORDER BY COALESCE(rides.completed_at, rides.cancelled_at, rides.accepted_at,
        rides.requested_at, rides.created_at) DESC, rides.id DESC
    `).all();
    const ratings = await database.prepare(`
      SELECT ratings.id, ratings.ride_id, ratings.stars, ratings.comment,
        ratings.created_at, raters.name AS rater_name, ratees.name AS ratee_name,
        rides.origin_label, rides.destination_label
      FROM ratings
      JOIN users AS raters ON raters.id = ratings.rater_id
      JOIN users AS ratees ON ratees.id = ratings.ratee_id
      JOIN rides ON rides.id = ratings.ride_id
      ORDER BY ratings.created_at DESC, ratings.id DESC
    `).all();

    return {
      requests: requests.map((ride) => ({
        id: ride.id,
        origin: ride.origin_label,
        destination: ride.destination_label,
        category: ride.category,
        proposedPriceMGA: ride.proposed_price_mga,
        status: ride.status,
        requestedAt: ride.requested_at,
        passenger: { id: ride.passenger_id, name: ride.passenger_name, phone: ride.passenger_phone },
        pendingOfferCount: ride.offer_count,
      })),
      onlineDrivers: onlineDrivers.map((driver) => ({
        id: driver.id,
        name: driver.name,
        photoUrl: driver.photo_url,
        phone: driver.phone,
        averageRating: driver.average_rating,
        ratingCount: driver.rating_count,
        vehicleCategory: driver.vehicle_category,
        vehicleRegistration: driver.vehicle_registration,
        available: Boolean(driver.is_available),
      })),
      onlinePassengers: onlineUsers.filter(({ role }) => role === 'passenger').map((passenger) => ({
        id: passenger.id,
        name: passenger.name,
        photoUrl: passenger.photo_url,
        phone: passenger.phone,
      })),
      history: history.map((ride) => ({
        id: ride.id,
        origin: ride.origin_label,
        destination: ride.destination_label,
        category: ride.category,
        proposedPriceMGA: ride.proposed_price_mga,
        agreedPriceMGA: ride.agreed_price_mga,
        status: ride.status,
        requestedAt: ride.requested_at,
        acceptedAt: ride.accepted_at,
        completedAt: ride.completed_at,
        cancelledAt: ride.cancelled_at,
        passengerName: ride.passenger_name,
        driverName: ride.driver_name,
      })),
      ratings: ratings.map((rating) => ({
        id: rating.id,
        rideId: rating.ride_id,
        stars: rating.stars,
        comment: rating.comment,
        createdAt: rating.created_at,
        raterName: rating.rater_name,
        rateeName: rating.ratee_name,
        origin: rating.origin_label,
        destination: rating.destination_label,
      })),
      presenceExpiresInSeconds: 90,
    };
  });

  app.post('/api/admin/accounts', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'phone', 'password'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 80 },
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          email: { anyOf: [{ type: 'string', maxLength: 254 }, { type: 'null' }] },
          password: { type: 'string', minLength: 10, maxLength: 128 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const admin = await database.prepare(
      'SELECT role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!admin) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });
    const phone = normalizePhone(request.body.phone);
    if (!phone) return reply.code(400).send({ error: 'PHONE_INVALID' });
    const email = request.body.email?.trim() ? normalizeEmail(request.body.email) : null;
    if (request.body.email?.trim() && !email) {
      return reply.code(400).send({ error: 'EMAIL_INVALID' });
    }
    const duplicate = await database.prepare(
      'SELECT phone, email FROM users WHERE phone = ? OR (? IS NOT NULL AND email = ?)',
    ).get(phone, email, email);
    if (duplicate) {
      return reply.code(409).send({
        error: duplicate.phone === phone ? 'PHONE_ALREADY_EXISTS' : 'EMAIL_ALREADY_EXISTS',
      });
    }
    const id = randomUUID();
    const passwordHash = await hashPassword(request.body.password);
    await database.prepare(`
      INSERT INTO users (id, phone, email, role, name, password_hash)
      VALUES (?, ?, ?, 'admin', ?, ?)
    `).run(id, phone, email, request.body.name.trim(), passwordHash);
    return reply.code(201).send({
      account: {
        id,
        phone,
        email,
        role: 'admin',
        name: request.body.name.trim(),
        isActive: true,
      },
    });
  });

  app.get('/api/admin/accounts', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 80 },
          role: { type: 'string', enum: ['all', 'passenger', 'driver', 'admin'] },
          status: { type: 'string', enum: ['all', 'active', 'inactive'] },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const admin = await database.prepare(
      'SELECT role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!admin) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });

    const query = request.query.q?.trim() ?? '';
    const role = request.query.role ?? 'all';
    const status = request.query.status ?? 'all';
    const accounts = await database.prepare(`
      SELECT users.id, users.name, users.phone, users.email, users.photo_url,
        users.average_rating, users.rating_count, users.is_active, users.created_at,
        users.role, driver_profiles.vehicle_category, driver_profiles.vehicle_make,
        driver_profiles.vehicle_model, driver_profiles.vehicle_color,
        driver_profiles.vehicle_registration, driver_profiles.is_online
      FROM users
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.role IN ('passenger', 'driver', 'admin')
        AND (? = 'all' OR users.role = ?)
        AND (? = 'all' OR users.is_active = ?)
        AND (? = '' OR users.name LIKE ? OR users.phone LIKE ? OR users.email LIKE ?)
      ORDER BY CASE users.role WHEN 'driver' THEN 0 ELSE 1 END, users.created_at DESC, users.id
    `).all(
      role,
      role,
      status,
      status === 'active' ? 1 : 0,
      query,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
    );
    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        phone: account.phone,
        email: account.email,
        photoUrl: account.photo_url,
        role: account.role,
        averageRating: account.average_rating,
        ratingCount: account.rating_count,
        isActive: Boolean(account.is_active),
        createdAt: account.created_at,
        vehicleCategory: account.vehicle_category,
        vehicleMake: account.vehicle_make,
        vehicleModel: account.vehicle_model,
        vehicleColor: account.vehicle_color,
        vehicleRegistration: account.vehicle_registration,
        isOnline: account.is_online === null ? null : Boolean(account.is_online),
      })),
    };
  });

  app.patch('/api/admin/accounts/:accountId/status', {
    schema: {
      params: {
        type: 'object',
        required: ['accountId'],
        properties: { accountId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['isActive'],
        properties: { isActive: { type: 'boolean' } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const admin = await database.prepare(
      'SELECT role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!admin) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });

    const target = await database.prepare(`
      SELECT users.id, users.name, users.phone, users.email, users.photo_url,
        users.average_rating, users.rating_count, users.is_active, users.created_at,
        users.role, driver_profiles.vehicle_category, driver_profiles.vehicle_make,
        driver_profiles.vehicle_model, driver_profiles.vehicle_color,
        driver_profiles.vehicle_registration, driver_profiles.is_online
      FROM users
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.role IN ('passenger', 'driver')
    `).get(request.params.accountId);
    if (!target) return reply.code(404).send({ error: 'ACCOUNT_NOT_FOUND' });

    const setStatus = database.transaction(async () => {
      if (!request.body.isActive) {
        const activeRide = await database.prepare(`
          SELECT 1
          FROM rides
          WHERE (passenger_id = ? OR driver_id = ?)
            AND status IN ('driver_en_route', 'driver_arrived', 'in_progress')
          LIMIT 1
        `).get(target.id, target.id);
        if (activeRide) return { error: 'ACCOUNT_HAS_ACTIVE_RIDE' };
      }

      const affectedRideIds = [];
      if (!request.body.isActive && target.is_active) {
        const openPassengerRides = (await database.prepare(`
          SELECT id
          FROM rides
          WHERE passenger_id = ? AND status IN ('searching', 'negotiating')
        `).all(target.id)).map(({ id }) => id);
        affectedRideIds.push(...openPassengerRides);
        const offeredRideIds = (await database.prepare(`
          SELECT DISTINCT ride_id
          FROM ride_offers
          WHERE proposer_id = ? AND status = 'pending'
        `).all(target.id)).map(({ ride_id }) => ride_id);
        affectedRideIds.push(...offeredRideIds);
        const now = new Date(clock()).toISOString();
        await database.prepare(`
          UPDATE rides
          SET status = 'cancelled', cancelled_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE passenger_id = ? AND status IN ('searching', 'negotiating')
        `).run(now, target.id);
        await database.prepare(`
          UPDATE ride_offers
          SET status = 'withdrawn', responded_at = ?
          WHERE status = 'pending' AND (
            proposer_id = ? OR ride_id IN (
              SELECT id FROM rides WHERE passenger_id = ? AND status = 'cancelled'
                AND cancelled_at = ?
            )
          )
        `).run(now, target.id, target.id, now);
        await database.prepare(`
          DELETE FROM ride_locations
          WHERE ride_id IN (SELECT id FROM rides WHERE passenger_id = ? AND status = 'cancelled' AND cancelled_at = ?)
        `).run(target.id, now);
      }

      await database.prepare(`
        UPDATE users
        SET is_active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(request.body.isActive ? 1 : 0, target.id);
      if (target.role === 'driver' && !request.body.isActive) {
        await database.prepare(`
          UPDATE driver_profiles
          SET is_online = 0, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).run(target.id);
      }
      return { affectedRideIds: [...new Set(affectedRideIds)] };
    });
    const result = await setStatus();
    if (result.error) return reply.code(409).send({ error: result.error });

    if (!request.body.isActive) {
      for (const [socket, client] of realtimeClients) {
        if (client.userId === target.id && socket.readyState === 1) {
          socket.close(4001, 'Account disabled');
        }
      }
    }
    for (const rideId of result.affectedRideIds) {
      const ride = await database.prepare('SELECT status FROM rides WHERE id = ?').get(rideId);
      publishRealtimeEvent(realtimeClients, rideId, {
        type: ride?.status === 'cancelled' ? 'ride.updated' : 'offers.updated',
        rideId,
        ...(ride?.status === 'cancelled' ? { status: ride.status } : {}),
      });
    }

    const account = await database.prepare(`
      SELECT users.id, users.name, users.phone, users.email, users.photo_url,
        users.average_rating, users.rating_count, users.is_active, users.created_at,
        users.role, driver_profiles.vehicle_category, driver_profiles.vehicle_make,
        driver_profiles.vehicle_model, driver_profiles.vehicle_color,
        driver_profiles.vehicle_registration, driver_profiles.is_online
      FROM users
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ?
    `).get(target.id);
    return {
      account: {
        id: account.id,
        name: account.name,
        phone: account.phone,
        email: account.email,
        photoUrl: account.photo_url,
        role: account.role,
        averageRating: account.average_rating,
        ratingCount: account.rating_count,
        isActive: Boolean(account.is_active),
        createdAt: account.created_at,
        vehicleCategory: account.vehicle_category,
        vehicleMake: account.vehicle_make,
        vehicleModel: account.vehicle_model,
        vehicleColor: account.vehicle_color,
        vehicleRegistration: account.vehicle_registration,
        isOnline: account.is_online === null ? null : Boolean(account.is_online),
      },
    };
  });

  app.get('/api/driver/availability', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const driver = await database.prepare(`
      SELECT driver_profiles.is_online
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.role = 'driver' AND users.is_active = 1
    `).get(request.user.sub);
    if (!driver) return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    return { isOnline: Boolean(driver.is_online) };
  });

  app.patch('/api/driver/availability', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['online'],
        properties: { online: { type: 'boolean' } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const driver = await database.prepare(`
      SELECT users.role
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.is_active = 1
    `).get(request.user.sub);
    if (!driver || driver.role !== 'driver') {
      return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    }
    await database.prepare(`
      UPDATE driver_profiles
      SET is_online = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(request.body.online ? 1 : 0, request.user.sub);
    return { isOnline: request.body.online };
  });

  app.get('/api/driver/rides', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const driver = await database.prepare(`
      SELECT users.id, users.role,
        driver_profiles.vehicle_category, driver_profiles.is_online
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.is_active = 1
    `).get(request.user.sub);
    if (!driver) return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    if (driver.role !== 'driver') return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    if (!driver.is_online) {
      return reply.code(403).send({ error: 'DRIVER_NOT_AVAILABLE' });
    }
    const rides = await database.prepare(`
      SELECT rides.id, rides.passenger_id, rides.origin_label, rides.origin_latitude,
        rides.origin_longitude, rides.destination_label, rides.destination_latitude,
        rides.destination_longitude, rides.category, rides.proposed_price_mga,
        rides.status, rides.requested_at,
        passenger_user.name AS passenger_name,
        passenger_user.phone AS passenger_phone,
        passenger_user.photo_url AS passenger_photo_url,
        (SELECT id FROM ride_offers
          WHERE ride_id = rides.id AND proposer_id = rides.passenger_id
          ORDER BY created_at, id LIMIT 1) AS initial_offer_id
      FROM rides
      JOIN users passenger_user ON passenger_user.id = rides.passenger_id
      WHERE rides.status IN ('searching', 'negotiating')
        AND rides.category = ?
        AND NOT EXISTS (
          SELECT 1 FROM rides active_ride
          WHERE active_ride.driver_id = ?
            AND active_ride.status IN ('driver_en_route', 'driver_arrived', 'in_progress')
        )
        AND NOT EXISTS (
          SELECT 1 FROM ride_offers pending_acceptance
          WHERE pending_acceptance.ride_id = rides.id
            AND pending_acceptance.proposer_id = ?
            AND pending_acceptance.responds_to_offer_id = (
              SELECT id FROM ride_offers
              WHERE ride_id = rides.id AND proposer_id = rides.passenger_id
                AND responds_to_offer_id IS NULL
              ORDER BY created_at, id LIMIT 1
            )
            AND pending_acceptance.status = 'pending'
            AND pending_acceptance.expires_at IS NOT NULL
        )
      ORDER BY rides.requested_at, rides.created_at
    `).all(driver.vehicle_category, driver.id, driver.id);

    return { rides: rides.map(toPublicRide) };
  });

  app.get('/api/driver/active-rides', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const driver = await database.prepare(`
      SELECT id FROM users
      WHERE id = ? AND role = 'driver' AND is_active = 1
    `).get(request.user.sub);
    if (!driver) return reply.code(403).send({ error: 'DRIVER_REQUIRED' });

    const rides = await database.prepare(`
      SELECT rides.id, rides.passenger_id, rides.driver_id, rides.origin_label, rides.origin_latitude,
        rides.origin_longitude, rides.destination_label, rides.destination_latitude,
        rides.destination_longitude, rides.category, rides.proposed_price_mga, rides.agreed_price_mga,
        rides.status, rides.requested_at, rides.accepted_at, rides.completed_at,
        passenger_user.name AS passenger_name,
        passenger_user.phone AS passenger_phone,
        passenger_user.photo_url AS passenger_photo_url
      FROM rides
      JOIN users passenger_user ON passenger_user.id = rides.passenger_id
      WHERE rides.driver_id = ?
        AND rides.status IN ('driver_en_route', 'driver_arrived', 'in_progress')
      ORDER BY rides.accepted_at DESC
    `).all(driver.id);
    const pendingOffers = await database.prepare(`
      SELECT ride_offers.id, ride_offers.ride_id, ride_offers.proposer_id,
        ride_offers.amount_mga, ride_offers.responds_to_offer_id,
        ride_offers.status, ride_offers.created_at, ride_offers.expires_at,
        rides.passenger_id, rides.origin_label, rides.origin_latitude,
        rides.origin_longitude, rides.destination_label, rides.destination_latitude,
        rides.destination_longitude, rides.category, rides.proposed_price_mga,
        rides.agreed_price_mga, rides.status AS ride_status, rides.requested_at,
        rides.accepted_at, users.name AS passenger_name
      FROM ride_offers
      JOIN rides ON rides.id = ride_offers.ride_id
      JOIN users ON users.id = rides.passenger_id
      WHERE ride_offers.proposer_id = ?
        AND ride_offers.status = 'pending'
        AND ride_offers.expires_at IS NOT NULL
      ORDER BY ride_offers.created_at DESC
    `).all(driver.id);
    const now = new Date(clock()).toISOString();
    const periods = antananarivoReportingPeriods(Date.parse(now));
    const stats = await database.prepare(`
      SELECT
        COALESCE(SUM(CASE
          WHEN julianday(completed_at) >= julianday(?)
            AND julianday(completed_at) <= julianday(?)
          THEN 1 ELSE 0 END), 0) AS completed_today,
        COALESCE(SUM(CASE
          WHEN julianday(completed_at) >= julianday(?)
            AND julianday(completed_at) <= julianday(?)
          THEN 1 ELSE 0 END), 0) AS completed_this_week
      FROM rides
      WHERE driver_id = ? AND status = 'completed' AND completed_at IS NOT NULL
    `).get(periods.todayStart, now, periods.weekStart, now, driver.id);
    return {
      rides: rides.map(toPublicRide),
      stats: {
        completedToday: stats.completed_today,
        completedThisWeek: stats.completed_this_week,
      },
      pendingOffers: pendingOffers.map((offer) => ({
        ...toPublicOffer(offer),
        ride: toPublicRide({
          ...offer,
          status: offer.ride_status,
        }),
        passengerName: offer.passenger_name,
      })),
    };
  });

  app.post('/api/rides/:rideId/offers', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['amountMGA', 'respondsToOfferId'],
        properties: {
          amountMGA: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          respondsToOfferId: { type: 'string', minLength: 1, maxLength: 36 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const ride = await database.prepare(`
      SELECT id, passenger_id, category, status
      FROM rides
      WHERE id = ?
    `).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (!['searching', 'negotiating'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_NOT_OPEN' });
    }

    if (account.role === 'driver') {
      const driver = await database.prepare(`
        SELECT vehicle_category, is_online
        FROM driver_profiles
        WHERE user_id = ?
      `).get(account.id);
      if (!driver || !driver.is_online) {
        return reply.code(403).send({ error: 'DRIVER_NOT_AVAILABLE' });
      }
      if (await hasActiveRide(database, account.id)) {
        return reply.code(409).send({ error: 'DRIVER_HAS_ACTIVE_RIDE' });
      }
      if (driver.vehicle_category !== ride.category) {
        return reply.code(403).send({ error: 'VEHICLE_CATEGORY_MISMATCH' });
      }
    } else if (account.role !== 'passenger' || account.id !== ride.passenger_id) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const parentOffer = await database.prepare(`
      SELECT id, proposer_id, status
      FROM ride_offers
      WHERE id = ? AND ride_id = ?
    `).get(request.body.respondsToOfferId, ride.id);
    if (!parentOffer) return reply.code(404).send({ error: 'OFFER_NOT_FOUND' });
    if (parentOffer.status !== 'pending' || parentOffer.proposer_id === account.id) {
      return reply.code(409).send({ error: 'OFFER_NOT_RESPONDABLE' });
    }

    const duplicate = await database.prepare(`
      SELECT 1
      FROM ride_offers
      WHERE ride_id = ? AND proposer_id = ?
        AND responds_to_offer_id = ? AND status = 'pending'
    `).get(ride.id, account.id, parentOffer.id);
    if (duplicate) return reply.code(409).send({ error: 'OFFER_ALREADY_SUBMITTED' });

    const offerId = randomUUID();
    const createOffer = database.transaction(async () => {
      await database.prepare(`
        INSERT INTO ride_offers (
          id, ride_id, proposer_id, amount_mga, responds_to_offer_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        offerId,
        ride.id,
        account.id,
        request.body.amountMGA,
        parentOffer.id,
      );
      await database.prepare(`
        UPDATE rides SET status = 'negotiating', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(ride.id);
    });
    await createOffer();
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'offers.updated',
      rideId: ride.id,
    });

    const offer = await database.prepare(`
      SELECT id, ride_id, proposer_id, amount_mga, responds_to_offer_id,
        status, created_at
      FROM ride_offers
      WHERE id = ?
    `).get(offerId);
    return reply.code(201).send({ offer: toPublicOffer(offer) });
  });

  app.get('/api/rides/:rideId/offers', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const ride = await database.prepare(
      'SELECT id, passenger_id, driver_id FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });

    const isPassenger = account.role === 'passenger' && account.id === ride.passenger_id;
    const isParticipatingDriver = account.role === 'driver' && await database.prepare(`
      SELECT 1 FROM ride_offers
      WHERE ride_id = ? AND proposer_id = ?
      LIMIT 1
    `).get(ride.id, account.id);
    if (!isPassenger && !isParticipatingDriver) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const offers = await database.prepare(`
      SELECT ride_offers.id, ride_offers.ride_id, ride_offers.proposer_id,
        ride_offers.amount_mga, ride_offers.responds_to_offer_id,
        ride_offers.status, ride_offers.created_at, ride_offers.expires_at,
        users.name AS proposer_name, users.phone AS proposer_phone,
        users.photo_url AS proposer_photo_url,
        users.average_rating AS proposer_average_rating,
        users.rating_count AS proposer_rating_count,
        driver_profiles.vehicle_category, driver_profiles.vehicle_make,
        driver_profiles.vehicle_model, driver_profiles.vehicle_color,
        driver_profiles.vehicle_registration
      FROM ride_offers
      JOIN users ON users.id = ride_offers.proposer_id
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE ride_offers.ride_id = ?
      ORDER BY ride_offers.created_at, ride_offers.id
    `).all(ride.id);
    const acceptedDriver = isPassenger && ride.driver_id
      ? await database.prepare(`
          SELECT users.id, users.name, users.phone, users.photo_url,
            users.average_rating, users.rating_count,
            driver_profiles.vehicle_category, driver_profiles.vehicle_make,
            driver_profiles.vehicle_model, driver_profiles.vehicle_color,
            driver_profiles.vehicle_registration
          FROM users
          JOIN driver_profiles ON driver_profiles.user_id = users.id
          WHERE users.id = ?
        `).get(ride.driver_id)
      : null;

    return {
      offers: offers.map((offer) => {
        const proposer = {
          id: offer.proposer_id,
          name: offer.proposer_name,
          phone: offer.proposer_phone ?? null,
          photoUrl: offer.proposer_photo_url,
          averageRating: offer.proposer_average_rating,
          ratingCount: offer.proposer_rating_count,
          vehicleCategory: offer.vehicle_category ?? null,
          vehicleMake: offer.vehicle_make ?? null,
          vehicleModel: offer.vehicle_model ?? null,
          vehicleColor: offer.vehicle_color ?? null,
          vehicleRegistration: offer.vehicle_registration ?? null,
        };
        const acceptedBy = acceptedDriver
          && offer.status === 'accepted'
          && offer.proposer_id === ride.passenger_id
          ? {
              id: acceptedDriver.id,
              name: acceptedDriver.name,
              phone: acceptedDriver.phone ?? null,
              photoUrl: acceptedDriver.photo_url,
              averageRating: acceptedDriver.average_rating,
              ratingCount: acceptedDriver.rating_count,
              vehicleCategory: acceptedDriver.vehicle_category,
              vehicleMake: acceptedDriver.vehicle_make,
              vehicleModel: acceptedDriver.vehicle_model,
              vehicleColor: acceptedDriver.vehicle_color,
              vehicleRegistration: acceptedDriver.vehicle_registration,
            }
          : null;
        return {
          ...toPublicOffer(offer),
          proposer,
          ...(acceptedBy ? { acceptedBy } : {}),
        };
      }),
    };
  });

  app.post('/api/rides/:rideId/accept', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const driver = await database.prepare(`
      SELECT users.id, users.role,
        driver_profiles.vehicle_category, driver_profiles.is_online
      FROM users
      JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE users.id = ? AND users.is_active = 1
    `).get(request.user.sub);
    if (!driver || driver.role !== 'driver') return reply.code(403).send({ error: 'DRIVER_REQUIRED' });
    if (!driver.is_online) {
      return reply.code(403).send({ error: 'DRIVER_NOT_AVAILABLE' });
    }
    const ride = await database.prepare(`
      SELECT id, passenger_id, category, status
      FROM rides
      WHERE id = ?
    `).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (!['searching', 'negotiating'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_NOT_OPEN' });
    }
    if (await hasActiveRide(database, driver.id)) {
      return reply.code(409).send({ error: 'DRIVER_HAS_ACTIVE_RIDE' });
    }
    if (ride.category !== driver.vehicle_category) {
      return reply.code(409).send({ error: 'RIDE_CATEGORY_MISMATCH' });
    }

    const offer = await database.prepare(`
      SELECT id, amount_mga, status
      FROM ride_offers
      WHERE ride_id = ? AND proposer_id = ? AND responds_to_offer_id IS NULL
      ORDER BY created_at, id
      LIMIT 1
    `).get(ride.id, ride.passenger_id);
    if (!offer || offer.status !== 'pending' || offer.amount_mga < 1) {
      return reply.code(409).send({ error: 'RIDE_PRICE_UNAVAILABLE' });
    }

    const duplicate = await database.prepare(`
      SELECT id
      FROM ride_offers
      WHERE ride_id = ? AND proposer_id = ? AND responds_to_offer_id = ?
        AND status = 'pending' AND expires_at IS NOT NULL
    `).get(ride.id, driver.id, offer.id);
    if (duplicate) return reply.code(409).send({ error: 'OFFER_ALREADY_SUBMITTED' });

    const offerId = randomUUID();
    const now = clock();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 15_000).toISOString();
    await database.prepare(`
      INSERT INTO ride_offers (
        id, ride_id, proposer_id, amount_mga, responds_to_offer_id,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      offerId,
      ride.id,
      driver.id,
      offer.amount_mga,
      offer.id,
      createdAt,
      expiresAt,
    );
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'offers.updated',
      rideId: ride.id,
    });

    const pendingOffer = await database.prepare(`
      SELECT id, ride_id, proposer_id, amount_mga, responds_to_offer_id,
        status, created_at, expires_at
      FROM ride_offers
      WHERE id = ?
    `).get(offerId);
    const currentRide = await database.prepare(`
      SELECT id, passenger_id, driver_id, origin_label, origin_latitude,
        origin_longitude, destination_label, destination_latitude,
        destination_longitude, category, proposed_price_mga, agreed_price_mga,
        status, requested_at, accepted_at,
        (SELECT id FROM ride_offers WHERE ride_id = rides.id
          AND proposer_id = rides.passenger_id AND responds_to_offer_id IS NULL
          ORDER BY created_at, id LIMIT 1) AS initial_offer_id
      FROM rides
      WHERE id = ?
    `).get(ride.id);
    return reply.code(201).send({
      offer: toPublicOffer(pendingOffer),
      ride: toPublicRide(currentRide),
      passengerConfirmationSeconds: 15,
    });
  });

  app.post('/api/rides/:rideId/cancel', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const user = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const ride = await database.prepare(
      'SELECT id, passenger_id, driver_id, status FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });

    const isPassenger = user.role === 'passenger' && ride.passenger_id === user.id;
    const isDriver = user.role === 'driver' && ride.driver_id === user.id;
    if (!isPassenger && !isDriver) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const cancellableStatuses = isPassenger
      ? ['searching', 'negotiating', 'driver_en_route', 'driver_arrived']
      : ['driver_en_route', 'driver_arrived'];
    if (!cancellableStatuses.includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_CANNOT_BE_CANCELLED' });
    }

    const cancelledAt = new Date(clock()).toISOString();
    const cancelRide = database.transaction(async () => {
      const updated = await database.prepare(`
        UPDATE rides
        SET status = 'cancelled', cancelled_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN (${cancellableStatuses.map(() => '?').join(',')})
      `).run(cancelledAt, ride.id, ...cancellableStatuses);
      if (updated.changes !== 1) return false;
      await database.prepare(`
        UPDATE ride_offers
        SET status = 'withdrawn', responded_at = ?
        WHERE ride_id = ? AND status = 'pending'
      `).run(cancelledAt, ride.id);
      await database.prepare('DELETE FROM ride_locations WHERE ride_id = ?').run(ride.id);
      return true;
    });
    if (!await cancelRide()) {
      return reply.code(409).send({ error: 'RIDE_CANNOT_BE_CANCELLED' });
    }
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'ride.updated',
      rideId: ride.id,
      status: 'cancelled',
    });

    const cancelledRide = await database.prepare(`
      SELECT id, passenger_id, driver_id, origin_label, origin_latitude,
        origin_longitude, destination_label, destination_latitude,
        destination_longitude, category, proposed_price_mga, agreed_price_mga,
        status, requested_at, accepted_at, completed_at, cancelled_at
      FROM rides
      WHERE id = ?
    `).get(ride.id);
    return { ride: toPublicRide(cancelledRide) };
  });

  app.post('/api/rides/:rideId/offers/:offerId/reject', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId', 'offerId'],
        properties: {
          rideId: { type: 'string', minLength: 1, maxLength: 36 },
          offerId: { type: 'string', minLength: 1, maxLength: 36 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const passenger = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!passenger) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (passenger.role !== 'passenger') {
      return reply.code(403).send({ error: 'PASSENGER_REQUIRED' });
    }

    const ride = await database.prepare(
      'SELECT id, passenger_id, status FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.passenger_id !== passenger.id) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }
    if (!['searching', 'negotiating'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_NOT_OPEN' });
    }

    const offer = await database.prepare(`
      SELECT ride_offers.id, ride_offers.ride_id, ride_offers.proposer_id,
        ride_offers.amount_mga, ride_offers.responds_to_offer_id,
        ride_offers.status, ride_offers.created_at, users.role AS proposer_role
      FROM ride_offers
      JOIN users ON users.id = ride_offers.proposer_id
      WHERE ride_offers.id = ? AND ride_offers.ride_id = ?
    `).get(request.params.offerId, ride.id);
    if (!offer) return reply.code(404).send({ error: 'OFFER_NOT_FOUND' });
    if (offer.status !== 'pending' || offer.proposer_role !== 'driver') {
      return reply.code(409).send({ error: 'OFFER_NOT_REJECTABLE' });
    }

    const rejection = await database.prepare(`
      UPDATE ride_offers
      SET status = 'rejected', responded_at = CURRENT_TIMESTAMP
      WHERE id = ? AND ride_id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM rides
          WHERE id = ? AND status IN ('searching', 'negotiating')
        )
    `).run(offer.id, ride.id, ride.id);
    if (rejection.changes !== 1) return reply.code(409).send({ error: 'OFFER_NOT_REJECTABLE' });

    const rejectedOffer = await database.prepare(`
      SELECT id, ride_id, proposer_id, amount_mga, responds_to_offer_id,
        status, created_at
      FROM ride_offers
      WHERE id = ?
    `).get(offer.id);
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'offers.updated',
      rideId: ride.id,
    });
    return { offer: toPublicOffer(rejectedOffer) };
  });

  app.post('/api/rides/:rideId/offers/:offerId/accept', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId', 'offerId'],
        properties: {
          rideId: { type: 'string', minLength: 1, maxLength: 36 },
          offerId: { type: 'string', minLength: 1, maxLength: 36 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    await expireTimedOffers();
    const passenger = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!passenger) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (passenger.role !== 'passenger') {
      return reply.code(403).send({ error: 'PASSENGER_REQUIRED' });
    }

    const ride = await database.prepare(
      'SELECT id, passenger_id, status FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.passenger_id !== passenger.id) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }
    if (!['searching', 'negotiating'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_NOT_OPEN' });
    }

    const offer = await database.prepare(`
      SELECT ride_offers.id, ride_offers.proposer_id, ride_offers.amount_mga,
        ride_offers.status, ride_offers.expires_at, users.role AS proposer_role,
        driver_profiles.is_online
      FROM ride_offers
      JOIN users ON users.id = ride_offers.proposer_id
      LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
      WHERE ride_offers.id = ? AND ride_offers.ride_id = ?
    `).get(request.params.offerId, ride.id);
    if (!offer) return reply.code(404).send({ error: 'OFFER_NOT_FOUND' });
    if (offer.status !== 'pending' || offer.proposer_role !== 'driver') {
      return reply.code(409).send({ error: 'OFFER_NOT_ACCEPTABLE' });
    }
    if (!offer.is_online) {
      return reply.code(409).send({ error: 'DRIVER_NOT_AVAILABLE' });
    }

    const acceptedAt = new Date(clock()).toISOString();
    const acceptOffer = database.transaction(async () => {
      if (await hasActiveRide(database, offer.proposer_id)) return false;
      const updatedOffer = await database.prepare(`
        UPDATE ride_offers
        SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > ?)
      `).run(offer.id, acceptedAt);
      if (updatedOffer.changes !== 1) return false;

      const updatedRide = await database.prepare(`
        UPDATE rides
        SET driver_id = ?, agreed_price_mga = ?, status = 'driver_en_route',
          accepted_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('searching', 'negotiating')
      `).run(offer.proposer_id, offer.amount_mga, acceptedAt, ride.id);
      if (updatedRide.changes !== 1) {
        throw new Error('Ride changed during offer acceptance.');
      }

      await database.prepare(`
        UPDATE ride_offers
        SET status = 'rejected', responded_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND id <> ? AND status = 'pending'
      `).run(ride.id, offer.id);
      return true;
    });

    if (!await acceptOffer()) {
      return reply.code(409).send({
        error: await hasActiveRide(database, offer.proposer_id)
          ? 'DRIVER_HAS_ACTIVE_RIDE'
          : 'OFFER_NOT_ACCEPTABLE',
      });
    }
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'ride.updated',
      rideId: ride.id,
      status: 'driver_en_route',
    });

    const acceptedRide = await database.prepare(`
      SELECT id, passenger_id, driver_id, origin_label, origin_latitude,
        origin_longitude, destination_label, destination_latitude,
        destination_longitude, category, proposed_price_mga, agreed_price_mga,
        status, requested_at, accepted_at
      FROM rides
      WHERE id = ?
    `).get(ride.id);
    return { ride: toPublicRide(acceptedRide) };
  });

  app.patch('/api/rides/:rideId/status', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['driver_arrived', 'in_progress', 'completed'] },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const driver = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!driver) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (driver.role !== 'driver') return reply.code(403).send({ error: 'DRIVER_REQUIRED' });

    const ride = await database.prepare(`
      SELECT id, passenger_id, driver_id, status FROM rides WHERE id = ?
    `).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.driver_id !== driver.id) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const nextStatuses = {
      driver_en_route: 'driver_arrived',
      driver_arrived: 'in_progress',
      in_progress: 'completed',
    };
    if (nextStatuses[ride.status] !== request.body.status) {
      return reply.code(409).send({ error: 'RIDE_STATUS_TRANSITION_INVALID' });
    }

    const completedAt = request.body.status === 'completed'
      ? new Date(clock()).toISOString()
      : null;
    const updated = await database.prepare(`
      UPDATE rides
      SET status = ?,
        completed_at = COALESCE(?, completed_at),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ?
    `).run(request.body.status, completedAt, ride.id, ride.status);
    if (updated.changes !== 1) {
      return reply.code(409).send({ error: 'RIDE_STATUS_TRANSITION_INVALID' });
    }
    if (request.body.status === 'completed') {
      await database.prepare('DELETE FROM ride_locations WHERE ride_id = ?').run(ride.id);
    }
    publishRealtimeEvent(realtimeClients, ride.id, {
      type: 'ride.updated',
      rideId: ride.id,
      status: request.body.status,
    });

    const updatedRide = await database.prepare(`
      SELECT id, passenger_id, driver_id, origin_label, origin_latitude,
        origin_longitude, destination_label, destination_latitude,
        destination_longitude, category, proposed_price_mga, agreed_price_mga,
        status, requested_at, accepted_at, completed_at
      FROM rides
      WHERE id = ?
    `).get(ride.id);
    return { ride: toPublicRide(updatedRide) };
  });

  app.post('/api/rides/:rideId/location', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['latitude', 'longitude'],
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const driver = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!driver) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (driver.role !== 'driver') return reply.code(403).send({ error: 'DRIVER_REQUIRED' });

    const ride = await database.prepare(`
      SELECT id, passenger_id, driver_id, status FROM rides WHERE id = ?
    `).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.driver_id !== driver.id) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }
    if (!['driver_en_route', 'driver_arrived', 'in_progress'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_LOCATION_NOT_ACTIVE' });
    }

    const updatedAt = new Date().toISOString();
    const location = {
      latitude: request.body.latitude,
      longitude: request.body.longitude,
      updatedAt,
    };
    await database.prepare(`
      INSERT INTO ride_locations (ride_id, driver_id, latitude, longitude, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (ride_id) DO UPDATE SET
        driver_id = excluded.driver_id,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated_at = excluded.updated_at
    `).run(ride.id, driver.id, location.latitude, location.longitude, location.updatedAt);
    publishRideParticipantEvent(realtimeClients, ride, {
      type: 'ride.location.updated',
      rideId: ride.id,
      location,
    });
    return { location: { rideId: ride.id, ...location } };
  });

  app.get('/api/rides/:rideId/messages', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const ride = await database.prepare(
      'SELECT id, passenger_id, driver_id FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (!isRideChatParticipant(account, ride)) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const messages = await database.prepare(`
      SELECT chat_messages.id, chat_messages.ride_id, chat_messages.sender_id,
        chat_messages.body, chat_messages.created_at,
        users.name AS sender_name, users.photo_url AS sender_photo_url
      FROM chat_messages
      JOIN users ON users.id = chat_messages.sender_id
      WHERE chat_messages.ride_id = ?
      ORDER BY chat_messages.created_at, chat_messages.id
    `).all(ride.id);
    return { messages: messages.map(toPublicChatMessage) };
  });

  app.post('/api/rides/:rideId/messages', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    const ride = await database.prepare(
      'SELECT id, passenger_id, driver_id, status FROM rides WHERE id = ?',
    ).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (!isRideChatParticipant(account, ride)) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }
    if (!['driver_en_route', 'driver_arrived', 'in_progress'].includes(ride.status)) {
      return reply.code(409).send({ error: 'RIDE_CHAT_NOT_ACTIVE' });
    }

    const body = request.body.body.trim();
    if (!body) return reply.code(400).send({ error: 'MESSAGE_REQUIRED' });

    const messageId = randomUUID();
    const createdAt = new Date().toISOString();
    await database.prepare(`
      INSERT INTO chat_messages (id, ride_id, sender_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, ride.id, account.id, body, createdAt);
    const message = await database.prepare(`
      SELECT chat_messages.id, chat_messages.ride_id, chat_messages.sender_id,
        chat_messages.body, chat_messages.created_at,
        users.name AS sender_name, users.photo_url AS sender_photo_url
      FROM chat_messages
      JOIN users ON users.id = chat_messages.sender_id
      WHERE chat_messages.id = ?
    `).get(messageId);
    const publicMessage = toPublicChatMessage(message);
    publishChatEvent(database, realtimeClients, ride, {
      type: 'message.created',
      rideId: ride.id,
      message: publicMessage,
    });
    return reply.code(201).send({ message: publicMessage });
  });

  app.post('/api/rides/:rideId/ratings', {
    schema: {
      params: {
        type: 'object',
        required: ['rideId'],
        properties: { rideId: { type: 'string', minLength: 1, maxLength: 36 } },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['stars'],
        properties: {
          stars: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const account = await database.prepare(
      'SELECT id, role FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!account) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    if (!['passenger', 'driver'].includes(account.role)) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }

    const ride = await database.prepare(`
      SELECT id, passenger_id, driver_id, status
      FROM rides
      WHERE id = ?
    `).get(request.params.rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (!isRideChatParticipant(account, ride)) {
      return reply.code(403).send({ error: 'RIDE_PARTICIPANT_REQUIRED' });
    }
    if (ride.status !== 'completed') {
      return reply.code(409).send({ error: 'RIDE_NOT_COMPLETED' });
    }

    const rateeId = account.id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
    if (!rateeId || rateeId === account.id) {
      return reply.code(409).send({ error: 'RATING_RECIPIENT_UNAVAILABLE' });
    }
    const ratingId = randomUUID();
    const comment = request.body.comment?.trim() || null;
    const createdAt = new Date().toISOString();
    try {
      await database.transaction(async () => {
        await database.prepare(`
          INSERT INTO ratings (id, ride_id, rater_id, ratee_id, stars, comment, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          ratingId,
          ride.id,
          account.id,
          rateeId,
          request.body.stars,
          comment,
          createdAt,
        );
        await database.prepare(`
          UPDATE users
          SET average_rating = (
            SELECT AVG(stars) FROM ratings WHERE ratee_id = ?
          ),
          rating_count = (
            SELECT COUNT(*) FROM ratings WHERE ratee_id = ?
          ),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(rateeId, rateeId, rateeId);
      })();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'RATING_ALREADY_SUBMITTED' });
      }
      throw error;
    }

    const rating = {
      id: ratingId,
      rideId: ride.id,
      raterId: account.id,
      rateeId,
      stars: request.body.stars,
      comment,
      createdAt,
    };
    const ratee = await database.prepare(`
      SELECT id, name, photo_url, average_rating, rating_count
      FROM users
      WHERE id = ?
    `).get(rateeId);
    return reply.code(201).send({
      rating,
      ratee: {
        id: ratee.id,
        name: ratee.name,
        photoUrl: ratee.photo_url,
        averageRating: ratee.average_rating,
        ratingCount: ratee.rating_count,
      },
    });
  });

  app.get('/api/places/reverse', {
    schema: {
      querystring: {
        type: 'object',
        required: ['latitude', 'longitude'],
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const latitude = request.query.latitude;
    const longitude = request.query.longitude;
    const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    const cached = reversePlaceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { label: cached.label };
    if (cached) reversePlaceCache.delete(cacheKey);

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      format: 'jsonv2',
      zoom: '18',
      addressdetails: '0',
    }).toString();
    const upstreamRequest = nominatimQueue.then(async () => {
      const delay = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
      if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      lastNominatimRequestAt = Date.now();
      return fetchImpl(url, {
        headers: {
          'User-Agent': 'DriveNight local address lookup',
          'Accept-Language': 'fr',
        },
        signal: AbortSignal.timeout(6000),
      });
    });
    nominatimQueue = upstreamRequest.then(() => undefined, () => undefined);

    try {
      const upstreamResponse = await upstreamRequest;
      if (!upstreamResponse.ok) throw new Error(`Nominatim HTTP ${upstreamResponse.status}`);
      const place = await upstreamResponse.json();
      if (typeof place?.display_name !== 'string' || !place.display_name.trim()) {
        return reply.code(404).send({ error: 'PLACE_NAME_NOT_FOUND' });
      }
      const label = place.display_name.trim().slice(0, 200);
      reversePlaceCache.set(cacheKey, { label, expiresAt: Date.now() + 60 * 60_000 });
      if (reversePlaceCache.size > 200) {
        reversePlaceCache.delete(reversePlaceCache.keys().next().value);
      }
      return { label };
    } catch (error) {
      request.log.warn({ err: error }, 'Reverse address lookup provider is unavailable');
      return reply.code(502).send({ error: 'PLACE_SEARCH_UNAVAILABLE' });
    }
  });

  app.get('/api/places/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', minLength: 3, maxLength: 100 },
        },
      },
    },
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const query = request.query.q.trim().replace(/\s+/g, ' ');
    if (query.length < 3) return reply.code(400).send({ error: 'PLACE_QUERY_TOO_SHORT' });

    const cacheKey = query.toLocaleLowerCase('fr');
    const cached = placeSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { places: cached.places };
    if (cached) placeSearchCache.delete(cacheKey);

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
      countrycodes: 'mg',
      viewbox: '47.45,-18.78,47.62,-18.96',
      bounded: '1',
    }).toString();

    const upstreamRequest = nominatimQueue.then(async () => {
      const delay = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
      if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      lastNominatimRequestAt = Date.now();
      return fetchImpl(url, {
        headers: {
          'User-Agent': 'DriveNight local address lookup',
          'Accept-Language': 'fr',
        },
        signal: AbortSignal.timeout(6000),
      });
    });
    nominatimQueue = upstreamRequest.then(() => undefined, () => undefined);

    try {
      const upstreamResponse = await upstreamRequest;
      if (!upstreamResponse.ok) throw new Error(`Nominatim HTTP ${upstreamResponse.status}`);
      const upstreamPlaces = await upstreamResponse.json();
      if (!Array.isArray(upstreamPlaces)) throw new Error('Nominatim returned an invalid response');

      const places = upstreamPlaces
        .filter((place) => place.place_id !== undefined && typeof place.display_name === 'string')
        .map((place) => ({
          id: String(place.place_id),
          label: place.display_name.slice(0, 200),
          latitude: Number(place.lat),
          longitude: Number(place.lon),
        }))
        .filter((place) => Number.isFinite(place.latitude) && Number.isFinite(place.longitude));

      placeSearchCache.set(cacheKey, {
        places,
        expiresAt: Date.now() + (places.length ? 60 * 60_000 : 60_000),
      });
      if (placeSearchCache.size > 200) {
        placeSearchCache.delete(placeSearchCache.keys().next().value);
      }
      return { places };
    } catch (error) {
      request.log.warn({ err: error }, 'Address search provider is unavailable');
      return reply.code(502).send({ error: 'PLACE_SEARCH_UNAVAILABLE' });
    }
  });

  app.get('/api/me', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      }
    },
  }, async (request, reply) => {
    const user = await database.prepare(
      'SELECT * FROM users WHERE id = ? AND is_active = 1',
    ).get(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    return toPublicProfile(await getProfileRecord(database, user.id));
  });

  return app;
}

function isUniqueConstraintError(error) {
  return error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505';
}

async function canSubscribeToRide(database, userId, rideId) {
  const account = await database.prepare(
    'SELECT role FROM users WHERE id = ? AND is_active = 1',
  ).get(userId);
  if (!account) return false;

  const ride = await database.prepare(`
    SELECT passenger_id, category, status
    FROM rides
    WHERE id = ?
  `).get(rideId);
  if (!ride) return false;
  if (account.role === 'passenger') return ride.passenger_id === userId;
  if (account.role !== 'driver') return false;

  const driver = await database.prepare(`
    SELECT vehicle_category, is_online
    FROM driver_profiles
    WHERE user_id = ?
  `).get(userId);
  if (!driver) return false;
  if (await database.prepare(`
    SELECT 1 FROM ride_offers
    WHERE ride_id = ? AND proposer_id = ?
    LIMIT 1
  `).get(rideId, userId)) return true;

  return Boolean(driver.is_online)
    && driver.vehicle_category === ride.category
    && ['searching', 'negotiating'].includes(ride.status);
}

async function hasActiveRide(database, driverId) {
  return Boolean(await database.prepare(`
    SELECT 1
    FROM rides
    WHERE driver_id = ?
      AND status IN ('driver_en_route', 'driver_arrived', 'in_progress')
    LIMIT 1
  `).get(driverId));
}

function antananarivoReportingPeriods(now) {
  const offsetMs = 3 * 60 * 60 * 1000;
  const localNow = new Date(now + offsetMs);
  const todayStart = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  ) - offsetMs;
  const weekday = new Date(todayStart + offsetMs).getUTCDay();
  const weekStart = todayStart - ((weekday + 6) % 7) * 24 * 60 * 60 * 1000;
  return {
    todayStart: new Date(todayStart).toISOString(),
    weekStart: new Date(weekStart).toISOString(),
  };
}

function isRideChatParticipant(account, ride) {
  return (account.role === 'passenger' && account.id === ride.passenger_id)
    || (account.role === 'driver' && account.id === ride.driver_id);
}

function toPublicChatMessage(message) {
  return {
    id: message.id,
    rideId: message.ride_id,
    senderId: message.sender_id,
    body: message.body,
    createdAt: message.created_at,
    sender: {
      id: message.sender_id,
      name: message.sender_name,
      photoUrl: message.sender_photo_url,
    },
  };
}

function publishRealtimeEvent(clients, rideId, event) {
  const message = JSON.stringify(event);
  for (const [socket, client] of clients) {
    if (client.rideIds.has(rideId) && socket.readyState === 1) {
      socket.send(message);
    }
  }
}

async function publishRideAvailability(clients, database, ride) {
  const message = JSON.stringify({ type: 'ride.available', rideId: ride.id });
  const findDriver = database.prepare(`
    SELECT 1
    FROM users
    JOIN driver_profiles ON driver_profiles.user_id = users.id
    WHERE users.id = ? AND users.role = 'driver' AND users.is_active = 1
      AND driver_profiles.is_online = 1
      AND driver_profiles.vehicle_category = ?
      AND NOT EXISTS (
        SELECT 1 FROM rides active_ride
        WHERE active_ride.driver_id = users.id
          AND active_ride.status IN ('driver_en_route', 'driver_arrived', 'in_progress')
      )
  `);
  for (const [socket, client] of clients) {
    if (socket.readyState === 1 && await findDriver.get(client.userId, ride.category)) {
      socket.send(message);
    }
  }
}

function publishChatEvent(database, clients, ride, event) {
  const message = JSON.stringify(event);
  for (const [socket, client] of clients) {
    if (client.rideIds.has(ride.id)
      && (client.userId === ride.passenger_id || client.userId === ride.driver_id)
      && socket.readyState === 1) {
      socket.send(message);
    }
  }
}

function publishRideParticipantEvent(clients, ride, event) {
  const message = JSON.stringify(event);
  for (const [socket, client] of clients) {
    if (client.rideIds.has(ride.id)
      && (client.userId === ride.passenger_id || client.userId === ride.driver_id)
      && socket.readyState === 1) {
      socket.send(message);
    }
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, passwordParameters);
  return `scrypt$${passwordParameters.N}$${passwordParameters.r}$${passwordParameters.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, saltHex, keyHex] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(
    password,
    Buffer.from(saltHex, 'hex'),
    expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizePhone(value) {
  const compact = value.replace(/[\s().-]/g, '');
  if (/^03\d{8}$/.test(compact)) return `+261${compact.slice(1)}`;
  if (/^\+2613\d{8}$/.test(compact)) return compact;
  return null;
}

function normalizeEmail(value) {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeVehicleRegistration(value) {
  const registration = value.trim().toUpperCase().replace(/\s+/g, ' ');
  return /^[A-Z0-9][A-Z0-9 -]{1,19}$/.test(registration) ? registration : null;
}

function decodeProfilePhoto(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('PROFILE_PHOTO_INVALID');
  const image = Buffer.from(match[1], 'base64');
  if (image.length > 512 * 1024) throw new Error('PROFILE_PHOTO_TOO_LARGE');
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    throw new Error('PROFILE_PHOTO_INVALID');
  }
  return image;
}

async function getProfileRecord(database, userId) {
  const user = await database.prepare(`
    SELECT users.*, driver_profiles.vehicle_category, driver_profiles.vehicle_registration,
      driver_profiles.active_vehicle_id
    FROM users
    LEFT JOIN driver_profiles ON driver_profiles.user_id = users.id
    WHERE users.id = ?
  `).get(userId);
  if (!user) return user;
  user.vehicles = await database.prepare(`
    SELECT id, category, vehicle_make, vehicle_model, vehicle_color,
      vehicle_registration, created_at
    FROM driver_vehicles
    WHERE user_id = ?
    ORDER BY created_at, id
  `).all(userId);
  return user;
}

function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, name.length - 1))}@${domain}`;
}

function maskPhone(phone) {
  return `${phone.slice(0, 5)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-2)}`;
}

function toPublicProfile(user) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
    role: user.role,
    name: user.name,
    photoUrl: user.photo_url,
    averageRating: user.average_rating,
    ratingCount: user.rating_count,
    vehicleCategory: user.vehicle_category ?? null,
    vehicleRegistration: user.vehicle_registration ?? null,
    activeVehicleId: user.active_vehicle_id ?? null,
    vehicles: (user.vehicles ?? []).map((vehicle) => ({
      id: vehicle.id,
      category: vehicle.category,
      make: vehicle.vehicle_make,
      model: vehicle.vehicle_model,
      color: vehicle.vehicle_color,
      registration: vehicle.vehicle_registration,
      createdAt: vehicle.created_at,
    })),
    termsAcceptedAt: user.terms_accepted_at,
    termsVersion: user.terms_version,
  };
}

function toPublicVehicle(vehicle) {
  return {
    id: vehicle.id,
    category: vehicle.category,
    make: vehicle.vehicle_make,
    model: vehicle.vehicle_model,
    color: vehicle.vehicle_color,
    registration: vehicle.vehicle_registration,
    createdAt: vehicle.created_at,
  };
}

function toPublicRide(ride) {
  return {
    id: ride.id,
    passengerId: ride.passenger_id,
    passenger: ride.passenger_name ? {
      id: ride.passenger_id,
      name: ride.passenger_name,
      phone: ride.passenger_phone ?? null,
      photoUrl: ride.passenger_photo_url ?? null,
    } : (ride.passenger ?? undefined),
    driverId: ride.driver_id ?? null,
    driver: ride.driver_name ? {
      id: ride.driver_id,
      name: ride.driver_name,
      phone: ride.driver_phone ?? null,
      photoUrl: ride.driver_photo_url ?? null,
    } : (ride.driver ?? undefined),
    origin: {
      label: ride.origin_label,
      latitude: ride.origin_latitude,
      longitude: ride.origin_longitude,
    },
    destination: {
      label: ride.destination_label,
      latitude: ride.destination_latitude,
      longitude: ride.destination_longitude,
    },
    category: ride.category,
    proposedPriceMGA: ride.proposed_price_mga,
    agreedPriceMGA: ride.agreed_price_mga ?? null,
    initialOfferId: ride.initial_offer_id ?? null,
    status: ride.status,
    requestedAt: ride.requested_at,
    acceptedAt: ride.accepted_at ?? null,
    completedAt: ride.completed_at ?? null,
    cancelledAt: ride.cancelled_at ?? null,
  };
}

function toPublicOffer(offer) {
  return {
    id: offer.id,
    rideId: offer.ride_id,
    proposerId: offer.proposer_id,
    amountMGA: offer.amount_mga,
    respondsToOfferId: offer.responds_to_offer_id,
    status: offer.status,
    createdAt: offer.created_at,
    expiresAt: offer.expires_at ?? null,
  };
}
