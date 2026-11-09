export function normalizePhoneNumber(value) {
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (/^03\d{8}$/.test(compact)) return `+261${compact.slice(1)}`;
  if (/^\+2613\d{8}$/.test(compact)) return compact;
  throw new Error('PHONE_INVALID');
}

function mapAuthError(error) {
  const message = error.message.toLowerCase();
  if (message.includes('email not confirmed') || message.includes('email confirmation')) {
    throw new Error('EMAIL_CONFIRMATION_REQUIRED');
  }
  if (message.includes('already registered') || message.includes('already exists')) {
    throw new Error('ACCOUNT_ALREADY_EXISTS');
  }
  if (message.includes('invalid login credentials') || message.includes('invalid credentials')) {
    throw new Error('INVALID_CREDENTIALS');
  }
  throw error;
}

export function createPhonePasswordAuth(client) {
  return {
    async register({ phone, password, metadata }) {
      const normalizedPhone = normalizePhoneNumber(phone);
      const authEmail = getPhoneAuthEmail(normalizedPhone);
      const { data, error } = await client.auth.signUp({
        email: authEmail,
        password,
        options: { data: { ...metadata, phone: normalizedPhone } },
      });
      if (error) mapAuthError(error);
      if (!data.session || !data.user) throw new Error('EMAIL_CONFIRMATION_REQUIRED');
      return data;
    },

    async login({ phone, password }) {
      const normalizedPhone = normalizePhoneNumber(phone);
      const { data, error } = await client.auth.signInWithPassword({
        email: getPhoneAuthEmail(normalizedPhone),
        password,
      });
      if (!error && data.session && data.user) return data;
      if (error && !error.message.toLowerCase().includes('invalid login credentials')) {
        mapAuthError(error);
      }

      const legacyResult = await client.auth.signInWithPassword({
        phone: normalizedPhone,
        password,
      });
      if (legacyResult.error) mapAuthError(legacyResult.error);
      if (!legacyResult.data.session || !legacyResult.data.user) {
        throw new Error('INVALID_CREDENTIALS');
      }
      return legacyResult.data;
    },
  };
}

function getPhoneAuthEmail(normalizedPhone) {
  // Supabase password auth needs an email provider when no SMS provider is configured.
  return `${normalizedPhone.slice(1)}@auth.drivenight.invalid`;
}
