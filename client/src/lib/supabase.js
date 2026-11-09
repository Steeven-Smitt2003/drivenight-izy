import { createClient } from '@supabase/supabase-js';
import {
  createClockAwareSupabaseFetch,
  createTabIsolatedAuthStorage,
  getOrCreateTabStorageKey,
} from './supabase-clock.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

if (Boolean(supabaseUrl) !== Boolean(supabasePublishableKey)) {
  throw new Error('Configurez VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY ensemble.');
}

if (supabaseUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error('VITE_SUPABASE_URL doit être une URL HTTPS valide.');
  }
  const isLocalHttp = parsedUrl.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);
  if ((!isLocalHttp && parsedUrl.protocol !== 'https:')
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.pathname !== '/'
    || parsedUrl.search
    || parsedUrl.hash) {
    throw new Error('VITE_SUPABASE_URL doit contenir uniquement l’origine HTTPS du projet.');
  }
}

export const supabase = supabaseUrl
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: getOrCreateTabStorageKey(),
        storage: createTabIsolatedAuthStorage(),
      },
      global: {
        fetch: createClockAwareSupabaseFetch(),
      },
    })
  : null;

export const supabaseEnabled = Boolean(supabase);
