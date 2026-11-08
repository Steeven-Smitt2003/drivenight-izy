<script>
  import { apiAssetUrl, apiFetch } from './lib/api.js';

  let { token, profile, onprofilechange, role = 'driver' } = $props();
  let profileName = $state('');
  let profilePhotoDraft = $state('');
  let phoneDraft = $state('');
  let phoneChallengeId = $state('');
  let phoneOtp = $state('');
  let demoPhoneOtp = $state('');
  let emailDraft = $state('');
  let emailChallengeId = $state('');
  let emailOtp = $state('');
  let demoEmailOtp = $state('');
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let showCurrentPassword = $state(false);
  let showNewPassword = $state(false);
  let showConfirmPassword = $state(false);
  let saving = $state(false);
  let message = $state('');
  let error = $state('');
  let photoError = $state('');

  const headers = () => ({ authorization: `Bearer ${token}` });
  const vehicle = $derived(profile.vehicles?.[0] ?? null);
  const profileEndpoint = '/api/account/profile';

  $effect(() => {
    profileName = profile.name;
    phoneDraft = profile.phone ?? '';
    emailDraft = profile.email ?? '';
  });

  async function responseBody(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    return body;
  }

  function setProfile(nextProfile) {
    onprofilechange(nextProfile);
  }

  async function handlePhotoChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    photoError = '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      photoError = 'Choisissez une image JPEG, PNG ou WebP.';
      input.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      photoError = 'La photo dépasse 8 Mo. Choisissez une image plus légère.';
      input.value = '';
      return;
    }
    try {
      const image = await createImageBitmap(file);
      try {
        const scale = Math.min(1, 512 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('CANVAS_UNAVAILABLE');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
        if (dataUrl.length > 700_000) throw new Error('PROFILE_PHOTO_TOO_LARGE');
        profilePhotoDraft = dataUrl;
      } finally {
        image.close();
      }
    } catch (photoRequestError) {
      photoError = photoRequestError.message === 'PROFILE_PHOTO_TOO_LARGE'
        ? 'La photo est trop volumineuse. Choisissez une image plus légère.'
        : 'Cette photo ne peut pas être traitée.';
      input.value = '';
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    saving = true;
    error = '';
    message = '';
    try {
      const payload = { name: profileName };
      if (profilePhotoDraft !== '') payload.profilePhoto = profilePhotoDraft;
      const body = await responseBody(await apiFetch(profileEndpoint, {
        method: 'PATCH',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }));
      profilePhotoDraft = '';
      profileName = body.profile.name;
      setProfile(body.profile);
      message = 'Votre profil a été mis à jour.';
    } catch {
      error = 'Votre profil n’a pas pu être enregistré. Vérifiez les informations et réessayez.';
    } finally {
      saving = false;
    }
  }

  async function requestEmailChange(event) {
    event.preventDefault();
    saving = true;
    error = '';
    message = '';
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/email/request`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailDraft }),
      }));
      emailChallengeId = body.challengeId;
      demoEmailOtp = body.otp ?? '';
      message = body.delivery === 'email'
        ? `Un code de confirmation a été envoyé à ${body.recipient}.`
        : `Un code de confirmation a été préparé pour ${body.recipient}.`;
    } catch (emailRequestError) {
      error = emailRequestError.message === 'EMAIL_ALREADY_IN_USE'
        ? 'Cette adresse e-mail est déjà associée à un autre compte.'
        : emailRequestError.message === 'OTP_SIMULATION_DISABLED'
          ? 'La confirmation d’e-mail est désactivée dans cet environnement.'
          : emailRequestError.message === 'EMAIL_DELIVERY_NOT_CONFIGURED'
            ? 'La vérification par e-mail n’est pas encore configurée.'
            : emailRequestError.message === 'EMAIL_RATE_LIMITED'
              ? 'Trop de codes ont été demandés. Réessayez dans une heure.'
              : emailRequestError.message === 'EMAIL_DELIVERY_FAILED'
                ? 'Le code n’a pas pu être envoyé. Réessayez plus tard.'
                : 'La demande de changement d’e-mail a échoué. Vérifiez l’adresse et réessayez.';
    } finally {
      saving = false;
    }
  }

  async function verifyEmailChange(event) {
    event.preventDefault();
    saving = true;
    error = '';
    message = '';
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/email/verify`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: emailChallengeId, otp: emailOtp }),
      }));
      setProfile(body.profile);
      emailDraft = body.profile.email;
      emailChallengeId = '';
      emailOtp = '';
      demoEmailOtp = '';
      message = 'Votre adresse e-mail a été confirmée et mise à jour.';
    } catch {
      error = 'Le code est invalide ou expiré. Demandez un nouveau code et réessayez.';
    } finally {
      saving = false;
    }
  }

  async function requestPhoneChange(event) {
    event.preventDefault();
    saving = true;
    error = '';
    message = '';
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/phone/request`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phoneDraft }),
      }));
      phoneChallengeId = body.challengeId;
      demoPhoneOtp = body.otp ?? '';
      message = `Un code de confirmation a été préparé pour ${body.recipient}.`;
    } catch (phoneRequestError) {
      error = phoneRequestError.message === 'PHONE_INVALID'
        ? 'Saisissez un numéro mobile malgache valide.'
        : phoneRequestError.message === 'PHONE_ALREADY_IN_USE'
          ? 'Ce numéro est déjà associé à un autre compte.'
          : phoneRequestError.message === 'PHONE_UNCHANGED'
            ? 'Ce numéro est déjà enregistré sur votre compte.'
            : phoneRequestError.message === 'OTP_SIMULATION_DISABLED'
              ? 'La confirmation du numéro est désactivée dans cet environnement.'
              : 'La demande de changement de numéro a échoué. Vérifiez le numéro et réessayez.';
    } finally {
      saving = false;
    }
  }

  async function verifyPhoneChange(event) {
    event.preventDefault();
    saving = true;
    error = '';
    message = '';
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/phone/verify`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: phoneChallengeId, otp: phoneOtp }),
      }));
      setProfile(body.profile);
      phoneDraft = body.profile.phone;
      phoneChallengeId = '';
      phoneOtp = '';
      demoPhoneOtp = '';
      message = 'Votre numéro de téléphone a été confirmé et mis à jour.';
    } catch (phoneVerificationError) {
      error = phoneVerificationError.message === 'PHONE_ALREADY_IN_USE'
        ? 'Ce numéro est déjà associé à un autre compte.'
        : 'Le code est invalide ou expiré. Demandez un nouveau code et réessayez.';
    } finally {
      saving = false;
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      error = 'Les deux nouveaux mots de passe ne correspondent pas.';
      return;
    }
    saving = true;
    error = '';
    message = '';
    try {
      await responseBody(await apiFetch(`${profileEndpoint}/password`, {
        method: 'PATCH',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      }));
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      message = 'Votre mot de passe a été changé.';
    } catch (passwordError) {
      error = passwordError.message === 'CURRENT_PASSWORD_INVALID'
        ? 'Votre mot de passe actuel est incorrect.'
        : 'Le mot de passe n’a pas pu être changé. Vérifiez les champs et réessayez.';
    } finally {
      saving = false;
    }
  }

</script>

<section id="account-settings" class="driver-account-settings" aria-label={role === 'driver' ? 'Véhicule et profil chauffeur' : 'Profil passager'}>
  {#if role === 'driver'}
  <section class="driver-vehicles" aria-labelledby="driver-vehicle-title">
    <div class="driver-settings-section__heading">
      <h2 id="driver-vehicle-title">Mon véhicule</h2>
    </div>
    {#if vehicle}
      <article class="driver-vehicle-summary">
        <div class="driver-vehicle-summary__icon" aria-hidden="true">
          {#if vehicle.category === 'moto'}
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" />
              <path d="m6 17 4-7h4l4 7m-8-7-2-3H5m7 3 2 4h4m-7-4h4" />
            </svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none">
              <path d="m4 12 1.7-5.1A2 2 0 0 1 7.6 5.5h8.8a2 2 0 0 1 1.9 1.4L20 12v6h-2v-2H6v2H4v-6Z" />
              <path d="M4 12h16M7 12l1-3h8l1 3" /><circle cx="7.5" cy="14" r=".75" /><circle cx="16.5" cy="14" r=".75" />
            </svg>
          {/if}
        </div>
        <div class="driver-vehicle-summary__details">
          <div class="driver-vehicle-summary__title">
            <div>
              <span>{vehicle.category === 'moto' ? 'Moto' : 'Voiture'}</span>
              <strong>{[vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Véhicule personnel'}</strong>
            </div>
          </div>
          <div class="driver-vehicle-summary__meta">
            <span class="driver-vehicle-summary__plate">{vehicle.registration}</span>
            {#if vehicle.color}<span>{vehicle.color}</span>{/if}
          </div>
        </div>
      </article>
    {:else}
      <p class="driver-account-settings__empty">Aucun véhicule n’est associé à ce compte. Contactez l’administrateur pour corriger votre dossier.</p>
    {/if}
  </section>
  {/if}

  <section class="driver-profile-settings" aria-labelledby="driver-profile-title">
    <div class="driver-profile-settings__heading">
      <h2 id="driver-profile-title">{role === 'driver' ? 'Profil et sécurité' : 'Mon profil'}</h2>
    </div>
    <div class="driver-profile-settings__content">
      <form class="driver-profile-form driver-profile-form--identity" onsubmit={saveProfile}>
        <div class="driver-settings-form__heading">
          <h3>Informations personnelles</h3>
        </div>
        <div class="driver-profile-form__photo">
          {#if profilePhotoDraft !== '' ? profilePhotoDraft : profile.photoUrl}
            <img
              src={apiAssetUrl(profilePhotoDraft !== '' ? profilePhotoDraft : profile.photoUrl)}
              alt=""
            />
          {:else}
            <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
              {profileName.slice(0, 1).toUpperCase()}
            </span>
          {/if}
          <div class="driver-profile-form__photo-action">
            <span class="driver-profile-form__photo-label">Photo de profil</span>
            <label class="driver-photo-picker">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 7.5h3l1.5-2h7l1.5 2h3v11H4z" />
                <circle cx="12" cy="13" r="3.2" />
                <path d="M18 10h.01" />
              </svg>
              <span>Choisir une photo</span>
              <input
                class="driver-photo-picker__input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onchange={handlePhotoChange}
              />
            </label>
            {#if profilePhotoDraft !== '' && profilePhotoDraft !== null}
              <button type="button" class="driver-profile-form__remove-photo" onclick={() => { profilePhotoDraft = null; }}>
                Supprimer la photo
              </button>
            {/if}
            {#if photoError}<p class="driver-account-settings__error" role="alert">{photoError}</p>{/if}
          </div>
        </div>
        <label>
          Nom
          <input bind:value={profileName} minlength="2" maxlength="80" required />
        </label>
        <button class="auth-secondary" type="submit" disabled={saving}>
          {saving ? 'Enregistrement…' : 'Enregistrer mon profil'}
        </button>
      </form>

      {#if role === 'passenger'}
        <form class="driver-profile-form driver-profile-form--phone" onsubmit={phoneChallengeId ? verifyPhoneChange : requestPhoneChange}>
          <div class="driver-settings-form__heading">
            <h3>Numéro de téléphone</h3>
            <p>Numéro actuel : <strong>{profile.phone}</strong></p>
          </div>
          <label>
            Nouveau numéro
            <input
              type="tel"
              bind:value={phoneDraft}
              autocomplete="tel"
              inputmode="tel"
              minlength="8"
              maxlength="20"
              required
              disabled={Boolean(phoneChallengeId)}
            />
          </label>
          {#if phoneChallengeId}
            <label>
              Code de confirmation
              <input bind:value={phoneOtp} inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required />
            </label>
            {#if demoPhoneOtp}
              <p class="driver-account-settings__hint">Code de démonstration local : <strong>{demoPhoneOtp}</strong></p>
            {/if}
          {/if}
          <button class="auth-secondary" type="submit" disabled={saving}>
            {saving ? 'Vérification…' : phoneChallengeId ? 'Confirmer mon numéro' : 'Vérifier ce numéro'}
          </button>
        </form>
      {/if}

      <form class="driver-profile-form driver-profile-form--email" onsubmit={emailChallengeId ? verifyEmailChange : requestEmailChange}>
        <div class="driver-settings-form__heading">
          <h3>Adresse e-mail</h3>
          <p>Adresse actuelle : <strong>{profile.email ?? 'aucune adresse enregistrée'}</strong></p>
        </div>
        <label>
          Nouvelle adresse e-mail
          <input type="email" bind:value={emailDraft} maxlength="254" required disabled={Boolean(emailChallengeId)} />
        </label>
        {#if emailChallengeId}
          <label>
            Code de confirmation
            <input bind:value={emailOtp} inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required />
          </label>
          {#if demoEmailOtp}
            <p class="driver-account-settings__hint">Code de démonstration local : <strong>{demoEmailOtp}</strong></p>
          {/if}
        {/if}
        <button class="auth-secondary" type="submit" disabled={saving}>
          {saving ? 'Vérification…' : emailChallengeId ? 'Confirmer mon e-mail' : 'Vérifier cette adresse'}
        </button>
      </form>

      <form class="driver-profile-form driver-profile-form--password" onsubmit={changePassword}>
        <div class="driver-settings-form__heading">
          <h3>Mot de passe</h3>
          <p>Choisissez un mot de passe d’au moins 10 caractères.</p>
        </div>
        <div class="driver-password-fields">
          <div class="driver-password-field">
            <label for="driver-current-password">Mot de passe actuel</label>
            <div class="driver-password-field__control">
              <input id="driver-current-password" type={showCurrentPassword ? 'text' : 'password'} bind:value={currentPassword} autocomplete="current-password" required />
              <button
                class="password-field__toggle"
                type="button"
                aria-label={showCurrentPassword ? 'Masquer le mot de passe actuel' : 'Afficher le mot de passe actuel'}
                aria-pressed={showCurrentPassword}
                onclick={() => { showCurrentPassword = !showCurrentPassword; }}
              >
                {#if showCurrentPassword}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </div>
          </div>
          <div class="driver-password-field">
            <label for="driver-new-password">Nouveau mot de passe</label>
            <div class="driver-password-field__control">
              <input id="driver-new-password" type={showNewPassword ? 'text' : 'password'} bind:value={newPassword} minlength="10" maxlength="128" autocomplete="new-password" required />
              <button
                class="password-field__toggle"
                type="button"
                aria-label={showNewPassword ? 'Masquer le nouveau mot de passe' : 'Afficher le nouveau mot de passe'}
                aria-pressed={showNewPassword}
                onclick={() => { showNewPassword = !showNewPassword; }}
              >
                {#if showNewPassword}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </div>
          </div>
          <div class="driver-password-field">
            <label for="driver-confirm-password">Confirmer le nouveau mot de passe</label>
            <div class="driver-password-field__control">
              <input id="driver-confirm-password" type={showConfirmPassword ? 'text' : 'password'} bind:value={confirmPassword} minlength="10" maxlength="128" autocomplete="new-password" required />
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
                    <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                {/if}
              </button>
            </div>
          </div>
        </div>
        <button class="auth-secondary" type="submit" disabled={saving}>
          {saving ? 'Enregistrement…' : 'Mettre à jour le mot de passe'}
        </button>
      </form>

      {#if error}<p class="driver-account-settings__error" role="alert">{error}</p>{/if}
      {#if message}<p class="driver-account-settings__notice" role="status">{message}</p>{/if}
    </div>
  </section>
</section>
