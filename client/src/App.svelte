<script>
  import { App as CapacitorApp } from '@capacitor/app';
  import { Capacitor } from '@capacitor/core';
  import { apiAssetUrl, apiFetch } from './lib/api.js';
  import {
    loginSupabaseAccount,
    registerSupabaseAccount,
    restoreSupabaseSession,
    restoreSupabaseSessionFromUrl,
    signOutSupabase,
    updateSupabaseProfile,
  } from './lib/supabase-auth.js';
  import { supabaseEnabled } from './lib/supabase.js';

  const isNativeMobileApp = Capacitor.isNativePlatform();
  let token = $state(window.localStorage.getItem('drivenight.token'));
  let profile = $state(null);
  let authOpen = $state(false);
  let authMode = $state('login');
  let phone = $state('');
  let role = $state('passenger');
  let name = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let showPassword = $state(false);
  let showConfirmPassword = $state(false);
  let termsAccepted = $state(false);
  let legalSection = $state('terms');
  let legalDialog;
  let vehicleCategory = $state('moto');
  let vehicleRegistration = $state('');
  let profilePhoto = $state('');
  let profilePhotoPreview = $state('');
  let authError = $state('');
  let busy = $state(false);
  let PassengerRequest = $state(null);
  let passengerLoadError = $state('');
  let AccountSettings = $state(null);
  let passengerAccountOpen = $state(false);
  let accountLoadError = $state('');
  let accountLoading = $state(false);
  let DriverDashboard = $state(null);
  let driverLoadError = $state('');
  let AdminDashboard = $state(null);
  let adminLoadError = $state('');
  const handledAuthUrls = new Set();

  async function responseBody(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    return body;
  }

  function handleRoleChange(nextRole) {
    role = nextRole;
    if (role !== 'driver') {
      vehicleCategory = 'moto';
      vehicleRegistration = '';
      profilePhoto = '';
      profilePhotoPreview = '';
    }
  }

  async function openPassengerAccount() {
    passengerAccountOpen = true;
    accountLoadError = '';
    if (AccountSettings || accountLoading) return;
    accountLoading = true;
    try {
      AccountSettings = (await import('./AccountSettings.svelte')).default;
    } catch {
      accountLoadError = 'Le profil ne peut pas être chargé. Fermez cette fenêtre et réessayez.';
    } finally {
      accountLoading = false;
    }
  }

  async function handlePhotoChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    authError = '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      authError = authErrorText('PROFILE_PHOTO_INVALID');
      input.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      authError = authErrorText('PROFILE_PHOTO_TOO_LARGE');
      input.value = '';
      return;
    }

    try {
      const image = await createImageBitmap(file);
      let compressed;
      try {
        const scale = Math.min(1, 512 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('CANVAS_UNAVAILABLE');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        compressed = canvas.toDataURL('image/jpeg', 0.78);
      } finally {
        image.close();
      }

      if (compressed.length > 700_000) throw new Error('PROFILE_PHOTO_TOO_LARGE');
      profilePhoto = compressed;
      profilePhotoPreview = compressed;
    } catch (error) {
      authError = error.message === 'PROFILE_PHOTO_TOO_LARGE'
        ? authErrorText('PROFILE_PHOTO_TOO_LARGE')
        : authErrorText('PROFILE_PHOTO_INVALID');
      input.value = '';
    }
  }

  function authErrorText(code) {
    return ({
      TERMS_NOT_ACCEPTED: 'Acceptez les conditions et la politique de confidentialité pour continuer.',
      DRIVER_VEHICLE_REQUIRED: 'Choisissez le type de véhicule et renseignez son numéro matricule.',
      VEHICLE_ALREADY_EXISTS: 'Ce numéro matricule est déjà associé à un compte chauffeur.',
      PROFILE_PHOTO_INVALID: 'Choisissez une image JPEG, PNG ou WebP valide.',
      PROFILE_PHOTO_TOO_LARGE: 'La photo est trop volumineuse. Choisissez une image plus légère.',
      PROFILE_PHOTO_DRIVER_ONLY: 'La photo de profil conducteur ne peut être ajoutée qu’à un compte chauffeur.',
      AUTH_SESSION_MISSING: 'Le lien de confirmation est incomplet. Demandez un nouveau message.',
      INVALID_CREDENTIALS: 'Numéro de téléphone ou mot de passe incorrect.',
      PHONE_INVALID: 'Saisissez un numéro mobile malgache valide.',
      EMAIL_CONFIRMATION_REQUIRED: 'Désactivez la confirmation des e-mails dans Supabase pour créer le compte sans code ni message.',
      NAME_REQUIRED: 'Ajoutez votre nom pour créer votre compte.',
      PASSWORD_MISMATCH: 'Les deux mots de passe ne correspondent pas.',
      PASSWORD_TOO_SHORT: 'Le mot de passe doit contenir au moins 10 caractères.',
      ACCOUNT_ALREADY_EXISTS: 'Un compte existe déjà avec ce numéro. Connectez-vous ou utilisez un autre numéro.',
      SUPABASE_NOT_CONFIGURED: 'La connexion Supabase n’est pas encore configurée.',
      PROFILE_NOT_FOUND: 'Le profil est introuvable. Vérifiez la configuration Supabase.',
    })[code] ?? 'La connexion a échoué. Vérifiez les informations et réessayez.';
  }

  async function restoreSession() {
    if (supabaseEnabled) {
      try {
        const session = await restoreSupabaseSession();
        if (!session) {
          window.localStorage.removeItem('drivenight.token');
          token = '';
          return;
        }
        token = session.token;
        profile = session.user;
      } catch {
        authError = 'Connexion à Supabase impossible. Vérifiez la configuration du projet.';
      }
      return;
    }
    if (!token) return;
    try {
      const response = await apiFetch('/api/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        window.localStorage.removeItem('drivenight.token');
        token = '';
        return;
      }

      profile = await responseBody(response);
    } catch {
      authError = 'Connexion au serveur impossible. Réessayez dans un instant.';
    }
  }

  async function handleSupabaseAuthUrl(url) {
    if (!url || handledAuthUrls.has(url)) return;
    handledAuthUrls.add(url);
    try {
      const session = await restoreSupabaseSessionFromUrl(url);
      if (session) {
        startSession(session);
        authError = '';
      }
    } catch (error) {
      authOpen = true;
      authMode = 'login';
      authError = error.message === 'AUTH_SESSION_MISSING'
        ? authErrorText(error.message)
        : 'Le lien de confirmation a expiré ou est invalide. Demandez un nouveau message.';
    }
  }

  async function listenForSupabaseAuthLinks() {
    if (!supabaseEnabled || !Capacitor.isNativePlatform()) return;

    try {
      const listener = await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        void handleSupabaseAuthUrl(url);
      });
      const launch = await CapacitorApp.getLaunchUrl();
      if (launch?.url) await handleSupabaseAuthUrl(launch.url);
      return () => { void listener.remove(); };
    } catch (error) {
      console.warn('DriveNight could not listen for confirmation links.', error);
      authError = 'Les liens de confirmation ne peuvent pas être ouverts. Réinstallez la dernière version de DriveNight.';
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    busy = true;
    authError = '';

    try {
      if (authMode === 'signup') {
        if (!termsAccepted) throw new Error('TERMS_NOT_ACCEPTED');
        if (password !== confirmPassword) throw new Error('PASSWORD_MISMATCH');
      }

      if (supabaseEnabled) {
        const session = authMode === 'login'
          ? await loginSupabaseAccount({ phone, password })
          : await registerSupabaseAccount({
              phone,
              password,
              metadata: {
                name: name.trim(),
                phone,
                role,
                terms_accepted: true,
                terms_version: '2026-11-05',
                vehicle_category: role === 'driver' ? vehicleCategory : undefined,
                vehicle_registration: role === 'driver' ? vehicleRegistration.trim() : undefined,
              },
            });
        if (authMode === 'signup' && profilePhoto) {
          const photoResponse = await fetch(profilePhoto);
          const photoFile = await photoResponse.blob();
          session.user = await updateSupabaseProfile({
            userId: session.user.id,
            name: session.user.name,
            photoFile,
          });
        }
        startSession(session);
        return;
      }

      if (authMode === 'login') {
        const body = await responseBody(await apiFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        }));
        startSession(body);
        return;
      }

      const driverDetails = role === 'driver'
        ? {
            vehicleCategory,
            vehicleRegistration,
            ...(profilePhoto ? { profilePhoto } : {}),
          }
        : {};
      const body = await responseBody(await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone,
          role,
          name: name.trim(),
          password,
          termsAccepted,
          ...driverDetails,
        }),
      }));
      startSession(body);
    } catch (error) {
      authError = authErrorText(error.message);
    } finally {
      busy = false;
    }
  }

  function startSession(body) {
    token = body.token;
    profile = body.user;
    if (supabaseEnabled) window.localStorage.removeItem('drivenight.token');
    else window.localStorage.setItem('drivenight.token', token);
    authOpen = false;
    password = '';
    confirmPassword = '';
    showPassword = false;
    showConfirmPassword = false;
    termsAccepted = false;
    vehicleCategory = 'moto';
    vehicleRegistration = '';
    profilePhoto = '';
    profilePhotoPreview = '';
  }

  async function logout() {
    if (supabaseEnabled) {
      try {
        await signOutSupabase();
      } catch {
        authError = 'La déconnexion n’a pas pu être confirmée. Réessayez.';
      }
    }
    window.localStorage.removeItem('drivenight.token');
    token = '';
    profile = null;
    authOpen = false;
    authError = '';
    showPassword = false;
    showConfirmPassword = false;
  }

  function cancelAuth() {
    authOpen = false;
    password = '';
    confirmPassword = '';
    termsAccepted = false;
    vehicleCategory = 'moto';
    vehicleRegistration = '';
    profilePhoto = '';
    profilePhotoPreview = '';
    authError = '';
    showPassword = false;
    showConfirmPassword = false;
  }

  function switchAuthMode(mode) {
    authMode = mode;
    password = '';
    confirmPassword = '';
    termsAccepted = false;
    authError = '';
    showPassword = false;
    showConfirmPassword = false;
  }

  function showLegal(section) {
    legalSection = section;
    legalDialog?.showModal();
  }

  $effect(() => {
    const activeToken = token;
    if (!activeToken || !profile) return;
    let active = true;
    const heartbeat = () => {
      if (!active || document.visibilityState !== 'visible') return;
      apiFetch('/api/presence', {
        method: 'POST',
        headers: { authorization: `Bearer ${activeToken}` },
      }).then((response) => {
        if (!response.ok) console.warn('DriveNight presence heartbeat was rejected.');
      }).catch((presenceError) => {
        console.warn('DriveNight presence heartbeat could not reach the server.', presenceError);
      });
    };
    const onVisibilityChange = () => heartbeat();
    heartbeat();
    const interval = window.setInterval(heartbeat, 30_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  $effect(() => {
    if (profile?.role !== 'passenger' || PassengerRequest || passengerLoadError) return;
    let active = true;
    import('./PassengerRequest.svelte')
      .then((module) => {
        if (active) PassengerRequest = module.default;
      })
      .catch(() => {
        if (active) passengerLoadError = 'Le formulaire de trajet ne peut pas être chargé. Actualisez la page pour réessayer.';
      });
    return () => {
      active = false;
    };
  });

  $effect(() => {
    if (profile?.role !== 'driver' || DriverDashboard || driverLoadError) return;
    let active = true;
    import('./DriverDashboard.svelte')
      .then((module) => {
        if (active) DriverDashboard = module.default;
      })
      .catch(() => {
        if (active) driverLoadError = 'L’espace chauffeur ne peut pas être chargé. Actualisez la page pour réessayer.';
      });
    return () => {
      active = false;
    };
  });

  $effect(() => {
    if (profile?.role !== 'admin' || AdminDashboard || adminLoadError) return;
    let active = true;
    import('./AdminDashboard.svelte')
      .then((module) => {
        if (active) AdminDashboard = module.default;
      })
      .catch(() => {
        if (active) adminLoadError = 'Le tableau de bord ne peut pas être chargé. Actualisez la page pour réessayer.';
      });
    return () => {
      active = false;
    };
  });

  document.documentElement.dataset.theme = 'dark';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', '#101A2A');
  void restoreSession();
  void listenForSupabaseAuthLinks();
</script>

{#if profile?.role === 'passenger'}
  <main class="passenger-app">
    <header class="passenger-app__topline">
      <div class="welcome__brand">
        <img
          class="welcome__logo"
          src="/logo-drivenight.webp"
          alt="DriveNight"
          width="960"
          height="228"
        />
      </div>
      <div class="passenger-app__account">
        <button
          class="passenger-app__profile"
          type="button"
          onclick={openPassengerAccount}
          aria-label={`Modifier le profil de ${profile.name}`}
        >
          {#if profile.photoUrl}
            <img src={apiAssetUrl(profile.photoUrl)} alt="" class="account-summary__photo" />
          {:else}
            <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
              {profile.name.slice(0, 1).toUpperCase()}
            </span>
          {/if}
          <span>
            <strong>{profile.name}</strong>
            <small>Passager · Mon profil</small>
          </span>
        </button>
        <button class="auth-secondary" type="button" onclick={logout}>Se déconnecter</button>
      </div>
    </header>
    {#if PassengerRequest}
      <PassengerRequest {token} />
    {:else if passengerLoadError}
      <p class="passenger-app__load-error" role="alert">{passengerLoadError}</p>
    {:else}
      <p class="passenger-app__loading" role="status">Préparation de votre trajet…</p>
    {/if}
    {#if passengerAccountOpen}
      <div class="passenger-account-overlay">
        <div class="passenger-account-panel" role="dialog" aria-modal="true" aria-labelledby="passenger-account-title" tabindex="-1">
          <header class="passenger-account-panel__header">
            <button type="button" class="passenger-account-panel__back" onclick={() => { passengerAccountOpen = false; }}>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m15 18-6-6 6-6M9 12h12" />
              </svg>
              <span>Retour au trajet</span>
            </button>
            <h2 id="passenger-account-title">Mon compte</h2>
          </header>
          {#if AccountSettings}
            <AccountSettings
              {token}
              {profile}
              role="passenger"
              onprofilechange={(nextProfile) => { profile = nextProfile; }}
            />
          {:else if accountLoadError}
            <p class="passenger-app__load-error" role="alert">{accountLoadError}</p>
          {:else}
            <p class="passenger-app__loading" role="status">Chargement du profil…</p>
          {/if}
        </div>
      </div>
    {/if}
  </main>
{:else if profile?.role === 'driver'}
  {#if DriverDashboard}
    <DriverDashboard {token} {profile} onlogout={logout} />
  {:else if driverLoadError}
    <p class="passenger-app__load-error" role="alert">{driverLoadError}</p>
  {:else}
    <p class="passenger-app__loading" role="status">Préparation de votre espace chauffeur…</p>
  {/if}
{:else if profile?.role === 'admin'}
  {#if AdminDashboard}
    <AdminDashboard {token} {profile} onlogout={logout} onprofilechange={(nextProfile) => { profile = nextProfile; }} />
  {:else if adminLoadError}
    <p class="passenger-app__load-error" role="alert">{adminLoadError}</p>
  {:else}
    <p class="passenger-app__loading" role="status">Préparation du tableau de bord…</p>
  {/if}
{:else}
<main class="welcome">
  <div class="welcome__topline">
    <div class="welcome__brand">
      <img
        class="welcome__logo"
        src="/logo-drivenight.webp"
        alt="DriveNight"
        width="960"
        height="228"
      />
    </div>
  </div>

  <section class="welcome__content" aria-labelledby="welcome-title">
    <div class="welcome__intro">
      <h1 id="welcome-title">Votre trajet<br /><span>Votre prix</span></h1>
      {#if profile}
        <div class="account-summary">
          <div class="account-summary__identity">
            {#if profile.photoUrl}
              <img src={apiAssetUrl(profile.photoUrl)} alt="" class="account-summary__photo" />
            {:else}
              <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
                {profile.name.slice(0, 1).toUpperCase()}
              </span>
            {/if}
            <div>
              <p>Connecté en tant que <strong>{profile.name}</strong></p>
              <span>{profile.role === 'driver' ? 'Chauffeur' : 'Passager'} · {profile.phone}</span>
            </div>
          </div>
          {#if profile.role === 'driver' && profile.vehicleRegistration}
            <span class="account-summary__vehicle">
              {profile.vehicleCategory === 'moto' ? 'Moto' : 'Voiture'} · Matricule {profile.vehicleRegistration}
            </span>
          {/if}
          <button class="auth-secondary" type="button" onclick={logout}>Se déconnecter</button>
        </div>
      {:else if !authOpen}
        <div class="welcome__actions">
          <button class="auth-submit auth-start" type="button" onclick={() => { authOpen = true; }}>
            Se connecter ou s’inscrire
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14m-6-6 6 6-6 6" />
            </svg>
          </button>
          {#if !isNativeMobileApp}
            <a
              class="welcome__apk-link"
              href="DriveNight.apk"
              download="DriveNight.apk"
            >
              <img src="/icons/android-download.svg" alt="" />
              <span>Télécharger l’application Android (.apk)</span>
            </a>
          {/if}
        </div>
      {/if}
    </div>
    {#if authOpen && !profile}
      <form class="auth-form" onsubmit={handleAuthSubmit}>
        <div class="auth-form__heading">
          <h2>{authMode === 'login' ? 'Ravi de vous revoir' : 'Créer un compte'}</h2>
          <p>{authMode === 'login' ? 'Connectez-vous avec votre téléphone et votre mot de passe.' : 'Aucun e-mail ni code à confirmer.'}</p>
        </div>
        <div class="auth-switch" aria-label="Choisir une action">
          <button
            class:auth-switch__active={authMode === 'login'}
            type="button"
            aria-pressed={authMode === 'login'}
            onclick={() => switchAuthMode('login')}
          >Connexion</button>
          <button
            class:auth-switch__active={authMode === 'signup'}
            type="button"
            aria-pressed={authMode === 'signup'}
            onclick={() => switchAuthMode('signup')}
          >Inscription</button>
        </div>
        {#if authMode === 'login'}
          <label>
            Numéro de téléphone
            <input
              bind:value={phone}
              autocomplete="tel"
              inputmode="tel"
              type="tel"
              maxlength="20"
              placeholder="034 00 000 01"
              required
            />
          </label>
          <label>
            Mot de passe
            <span class="password-field">
              <input
                bind:value={password}
                type={showPassword ? 'text' : 'password'}
                autocomplete="current-password"
                minlength="10"
                maxlength="128"
                required
              />
              <button
                class="password-field__toggle"
                type="button"
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                aria-pressed={showPassword}
                onclick={() => { showPassword = !showPassword; }}
              >
                {#if showPassword}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </span>
          </label>
        {:else}
          <label>
            Votre nom
            <input
              bind:value={name}
              autocomplete="name"
              maxlength="80"
              placeholder="Ex. Miora Rakoto"
              required
            />
          </label>
          <label>
            Numéro de téléphone
            <input
              bind:value={phone}
              autocomplete="tel"
              inputmode="tel"
              type="tel"
              maxlength="20"
              placeholder="034 00 000 01"
              required
            />
          </label>
          <fieldset class="auth-choice-group">
            <legend>Je suis</legend>
            <div class="auth-choice-group__options">
              <button
                class="auth-choice"
                class:auth-choice--selected={role === 'passenger'}
                type="button"
                aria-pressed={role === 'passenger'}
                onclick={() => handleRoleChange('passenger')}
              >
                <img src="/icons/passenger.svg" alt="" />
                <span>Passager</span>
              </button>
              <button
                class="auth-choice"
                class:auth-choice--selected={role === 'driver'}
                type="button"
                aria-pressed={role === 'driver'}
                onclick={() => handleRoleChange('driver')}
              >
                <img src="/icons/car-front.svg" alt="" />
                <span>Chauffeur</span>
              </button>
            </div>
          </fieldset>
          {#if role === 'driver'}
            <div class="driver-signup-fields">
              <div class="profile-photo-field">
                <div class="profile-photo-field__preview">
                  {#if profilePhotoPreview}
                    <img src={profilePhotoPreview} alt="" />
                  {:else}
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="8" r="3.5" />
                      <path d="M5 20c.7-3.5 3.2-5.3 7-5.3s6.3 1.8 7 5.3" />
                    </svg>
                  {/if}
                </div>
                <div class="profile-photo-field__copy">
                  <strong>Photo de profil</strong>
                  <span>Facultative · visage bien visible</span>
                </div>
                <label class="profile-photo-field__button" for="driver-profile-photo">
                  {profilePhotoPreview ? 'Changer' : 'Ajouter'}
                </label>
                <input
                  id="driver-profile-photo"
                  class="profile-photo-field__input"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onchange={handlePhotoChange}
                />
              </div>
              <fieldset class="auth-choice-group auth-choice-group--vehicle">
                <legend>Type de véhicule</legend>
                <div class="auth-choice-group__options">
                  <button
                    class="auth-choice"
                    class:auth-choice--selected={vehicleCategory === 'moto'}
                    type="button"
                    aria-pressed={vehicleCategory === 'moto'}
                    onclick={() => { vehicleCategory = 'moto'; }}
                  >
                    <img src="/icons/bike.svg" alt="" />
                    <span>Moto</span>
                  </button>
                  <button
                    class="auth-choice"
                    class:auth-choice--selected={vehicleCategory === 'voiture'}
                    type="button"
                    aria-pressed={vehicleCategory === 'voiture'}
                    onclick={() => { vehicleCategory = 'voiture'; }}
                  >
                    <img src="/icons/car-front.svg" alt="" />
                    <span>Voiture</span>
                  </button>
                </div>
              </fieldset>
              <label>
                Numéro matricule
                <input
                  bind:value={vehicleRegistration}
                  autocomplete="off"
                  maxlength="20"
                  placeholder="Ex. 1234 TAA"
                  required
                />
              </label>
            </div>
          {/if}
          <label>
            Mot de passe
            <span class="password-field">
              <input
                bind:value={password}
                type={showPassword ? 'text' : 'password'}
                autocomplete="new-password"
                minlength="10"
                maxlength="128"
                required
              />
              <button
                class="password-field__toggle"
                type="button"
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                aria-pressed={showPassword}
                onclick={() => { showPassword = !showPassword; }}
              >
                {#if showPassword}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </span>
          </label>
          <p class="auth-form__hint">10 caractères minimum.</p>
          <label>
            Confirmer le mot de passe
            <span class="password-field">
              <input
                bind:value={confirmPassword}
                type={showConfirmPassword ? 'text' : 'password'}
                autocomplete="new-password"
                minlength="10"
                maxlength="128"
                required
              />
              <button
                class="password-field__toggle"
                type="button"
                aria-label={showConfirmPassword ? 'Masquer la confirmation du mot de passe' : 'Afficher la confirmation du mot de passe'}
                aria-pressed={showConfirmPassword}
                onclick={() => { showConfirmPassword = !showConfirmPassword; }}
              >
                {#if showConfirmPassword}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </span>
          </label>
          <label class="terms-consent">
            <input bind:checked={termsAccepted} type="checkbox" required />
            <span>J’accepte les Conditions d’utilisation et la Politique de confidentialité.</span>
          </label>
          <div class="auth-legal-links">
            <button type="button" onclick={() => showLegal('terms')}>Lire les conditions</button>
            <button type="button" onclick={() => showLegal('privacy')}>Lire la politique de confidentialité</button>
          </div>
        {/if}
        {#if authError}
          <p class="auth-feedback auth-feedback--error" role="alert">{authError}</p>
        {/if}
        <button class="auth-submit" type="submit" disabled={busy}>
          {busy
            ? 'Un instant…'
            : authMode === 'signup' ? 'Créer mon compte' : 'Se connecter'}
        </button>
        <button class="auth-secondary" type="button" onclick={cancelAuth}>
          Annuler
        </button>
      </form>
    {:else}
      <div class="route-art" aria-hidden="true">
        <svg class="route-art__map" viewBox="0 0 440 400" fill="none" preserveAspectRatio="none">
          <path class="route-art__street" d="M-25 91 89 139l91-79 74 40 95-51 114 60M-32 281l106-55 59 29 86-79 80 38 55-47 117 44M56 438l33-100 91-50 47 28 49-66 87-10 42-53 79-2" />
          <path class="route-art__street route-art__street--thin" d="m88-24 44 75-23 74 71 60-57 71 72 83-23 86M257-27l-3 87 57 56-23 98 72 82-2 131M433 16l-84 53 24 65-42 94 52 46-19 108" />
          <path class="route-art__journey" d="M128 284c11-60 39-94 83-102 44-8 71 11 94-25 20-30 6-54-16-67" />
          <circle class="route-art__stop" cx="128" cy="284" r="10" />
          <circle class="route-art__stop route-art__stop--end" cx="289" cy="90" r="10" />
        </svg>
        <div class="route-art__origin">
          <span class="route-art__marker"></span>
          <span>Départ</span>
        </div>
        <div class="route-art__destination">
          <span class="route-art__marker route-art__marker--end"></span>
          <span>Destination</span>
        </div>
        <div class="route-art__price">À vous de choisir</div>
      </div>
    {/if}
  </section>

</main>
{/if}

<dialog
  class="legal-dialog"
  bind:this={legalDialog}
  aria-labelledby="legal-title"
>
  <div class="legal-dialog__header">
    <h2 id="legal-title">{legalSection === 'terms' ? 'Conditions d’utilisation' : 'Politique de confidentialité'}</h2>
    <button
      class="legal-dialog__close"
      type="button"
      aria-label="Fermer"
      onclick={() => legalDialog.close()}
    >×</button>
  </div>
  {#if legalSection === 'terms'}
    <div class="legal-dialog__body">
      <p class="legal-dialog__updated">Version du 5 novembre 2026 · prototype local</p>
      <h3>Utilisation de DriveNight</h3>
      <p>DriveNight est actuellement un prototype de démonstration exécuté en local. Certaines fonctions présentées peuvent ne pas être disponibles ou ne pas fonctionner comme un service de transport réel.</p>
      <h3>Compte et informations</h3>
      <p>Fournissez des informations exactes et gardez votre mot de passe confidentiel. Les chauffeurs doivent aussi renseigner leur type de véhicule et son numéro matricule. Vous êtes responsable de l’utilisation de votre compte et des messages envoyés depuis celui-ci.</p>
      <h3>Prix et règlement</h3>
      <p>Le prix d’un trajet est convenu directement entre le passager et le chauffeur. DriveNight ne collecte, ne conserve et ne traite aucun paiement ; le règlement se fait en dehors de l’application.</p>
      <h3>Comportement et sécurité</h3>
      <p>Utilisez l’application avec respect, sans harcèlement, fraude ni contenu illicite. Vérifiez les informations de trajet et prenez vos propres décisions de sécurité avant toute rencontre ou déplacement.</p>
      <h3>Disponibilité</h3>
      <p>Le prototype est fourni à des fins d’essai, sans garantie de disponibilité continue. Ces conditions devront être révisées avant toute mise en service publique.</p>
    </div>
  {:else}
    <div class="legal-dialog__body">
      <p class="legal-dialog__updated">Version du 5 novembre 2026 · prototype local</p>
      <h3>Informations enregistrées</h3>
      <p>Pour créer votre compte, DriveNight enregistre votre nom, votre numéro de téléphone unique, votre rôle et la date/version de votre acceptation. Si vous êtes chauffeur, votre type de véhicule et son numéro matricule sont également enregistrés. La photo de profil est facultative. Votre mot de passe est stocké sous forme de hash, pas en clair.</p>
      <h3>Stockage et vérification</h3>
      <p>Dans cette version locale, les informations du compte sont conservées dans la base SQLite du serveur local. Les photos de profil sont réduites puis enregistrées sur le disque du serveur local. La session est conservée dans le stockage local de votre navigateur. Aucun code de vérification n’est demandé à la création du compte.</p>
      <h3>Partage</h3>
      <p>Ce prototype ne configure aucun prestataire externe de paiement, de messagerie ou d’authentification. N’utilisez pas de vraies informations sensibles dans les données de démonstration.</p>
      <h3>Vos choix</h3>
      <p>Vous pouvez ne pas créer de compte. Avant toute mise en ligne, cette politique devra être adaptée aux services réellement utilisés et aux droits applicables.</p>
    </div>
  {/if}
  <button class="auth-submit legal-dialog__done" type="button" onclick={() => legalDialog.close()}>
    J’ai compris
  </button>
</dialog>
