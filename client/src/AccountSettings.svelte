<script>
  import { untrack } from 'svelte';
  import PasswordField from './PasswordField.svelte';
  import { apiAssetUrl, apiFetch } from './lib/api.js';
  import { normalizePhoneNumber } from './lib/phone-password-auth.js';
  import { prepareProfilePhoto } from './lib/profile-photo.js';
  import { supabaseEnabled } from './lib/supabase.js';
  import {
    changeSupabasePassword,
    changeSupabasePhone,
    updateSupabaseProfile,
    updateSupabaseVehicle,
  } from './lib/supabase-auth.js';
  import { normalizeVehicleDetails } from './lib/vehicle-fields.js';

  let { token, profile, onprofilechange, onlogout, role = 'driver' } = $props();
  let profileName = $state('');
  let photoDraft = $state(null);
  let removePhoto = $state(false);
  let photoBroken = $state(false);
  let photoBusy = $state(false);
  let photoError = $state('');
  let phoneDraft = $state('');
  let phonePassword = $state('');
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
  let vehicleMake = $state('');
  let vehicleModel = $state('');
  let vehicleColor = $state('');
  let vehicleRegistration = $state('');
  let savingSection = $state('');
  let feedback = $state({ section: '', type: '', text: '' });

  const headers = () => ({ authorization: `Bearer ${token}` });
  const vehicle = $derived(profile.vehicles?.[0] ?? null);
  const profileEndpoint = '/api/account/profile';
  const photoSource = $derived(
    photoDraft ? photoDraft.previewUrl : removePhoto ? '' : (profile.photoUrl ?? ''),
  );

  $effect(() => {
    const current = profile;
    untrack(() => {
      profileName = current.name;
      phoneDraft = current.phone ?? '';
      emailDraft = current.email ?? '';
      const owned = current.vehicles?.[0];
      vehicleMake = owned?.make ?? '';
      vehicleModel = owned?.model ?? '';
      vehicleColor = owned?.color ?? '';
      vehicleRegistration = owned?.registration ?? '';
    });
  });

  function notify(section, type, text) {
    feedback = { section, type, text };
  }

  async function responseBody(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    return body;
  }

  function setProfile(nextProfile) {
    onprofilechange(nextProfile);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function clearPhotoDraft() {
    if (photoDraft?.previewUrl) URL.revokeObjectURL(photoDraft.previewUrl);
    photoDraft = null;
  }

  async function handlePhotoChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    photoError = '';
    photoBusy = true;
    try {
      const { blob } = await prepareProfilePhoto(file);
      clearPhotoDraft();
      photoDraft = { blob, previewUrl: URL.createObjectURL(blob) };
      photoBroken = false;
      removePhoto = false;
    } catch (photoRequestError) {
      photoError = photoRequestError.message === 'PROFILE_PHOTO_TOO_LARGE'
        ? 'Cette image dépasse 20 Mo. Choisissez une image plus légère.'
        : 'Ce fichier n’est pas une image. Choisissez une photo.';
      input.value = '';
    } finally {
      photoBusy = false;
    }
  }

  function discardPhoto() {
    clearPhotoDraft();
    photoBroken = false;
    removePhoto = Boolean(profile.photoUrl);
  }

  async function saveProfile(event) {
    event.preventDefault();
    savingSection = 'identity';
    notify('', '', '');
    try {
      if (supabaseEnabled) {
        const nextProfile = await updateSupabaseProfile({
          userId: profile.id,
          name: profileName,
          photo: photoDraft?.blob ?? null,
          removePhoto,
        });
        clearPhotoDraft();
        removePhoto = false;
        profileName = nextProfile.name;
        setProfile(nextProfile);
        notify('identity', 'notice', 'Votre profil a été mis à jour.');
        return;
      }
      const payload = { name: profileName };
      if (photoDraft) payload.profilePhoto = await blobToDataUrl(photoDraft.blob);
      else if (removePhoto) payload.profilePhoto = null;
      const body = await responseBody(await apiFetch(profileEndpoint, {
        method: 'PATCH',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }));
      clearPhotoDraft();
      removePhoto = false;
      profileName = body.profile.name;
      setProfile(body.profile);
      notify('identity', 'notice', 'Votre profil a été mis à jour.');
    } catch {
      notify('identity', 'error', 'Votre profil n’a pas pu être enregistré. Vérifiez les informations et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function saveVehicle(event) {
    event.preventDefault();
    if (!vehicle) return;
    notify('', '', '');
    const checked = normalizeVehicleDetails({
      category: vehicle.category,
      color: vehicleColor,
      make: vehicleMake,
      registration: vehicleRegistration,
    });
    if (!checked.ok) {
      notify('vehicle', 'error', 'Renseignez tous les champs obligatoires du véhicule.');
      return;
    }
    savingSection = 'vehicle';
    try {
      const nextProfile = await updateSupabaseVehicle({
        userId: profile.id,
        make: checked.vehicle.make,
        model: vehicleModel,
        color: checked.vehicle.color,
        registration: checked.vehicle.registration,
      });
      setProfile(nextProfile);
      notify('vehicle', 'notice', 'Votre véhicule a été mis à jour.');
    } catch (vehicleError) {
      notify('vehicle', 'error', vehicleError.message === 'VEHICLE_ALREADY_EXISTS'
        ? 'Ce matricule est déjà associé à un autre chauffeur.'
        : vehicleError.message === 'DRIVER_VEHICLE_REQUIRED'
          ? 'Renseignez tous les champs obligatoires du véhicule.'
          : 'Votre véhicule n’a pas pu être enregistré. Réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function savePhone(event) {
    event.preventDefault();
    notify('', '', '');
    let normalized;
    try {
      normalized = normalizePhoneNumber(phoneDraft);
    } catch {
      notify('phone', 'error', 'Saisissez un numéro mobile malgache valide (ex. 034 00 000 01).');
      return;
    }
    if (normalized === profile.phone) {
      notify('phone', 'error', 'Ce numéro est déjà enregistré sur votre compte.');
      return;
    }
    savingSection = 'phone';
    try {
      const nextProfile = await changeSupabasePhone({
        userId: profile.id,
        phone: phoneDraft,
        password: phonePassword,
      });
      phonePassword = '';
      setProfile(nextProfile);
      notify('phone', 'notice', 'Votre numéro a été changé. Utilisez-le pour vos prochaines connexions.');
    } catch (phoneError) {
      notify('phone', 'error', {
        PHONE_INVALID: 'Saisissez un numéro mobile malgache valide (ex. 034 00 000 01).',
        PHONE_ALREADY_IN_USE: 'Ce numéro est déjà associé à un autre compte.',
        CURRENT_PASSWORD_INVALID: 'Votre mot de passe actuel est incorrect.',
      }[phoneError.message] ?? 'Le numéro n’a pas pu être changé. Vérifiez les champs et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    notify('', '', '');
    if (newPassword.length < 10) {
      notify('password', 'error', 'Le mot de passe doit contenir au moins 10 caractères.');
      return;
    }
    if (newPassword !== confirmPassword) {
      notify('password', 'error', 'Les deux nouveaux mots de passe ne correspondent pas.');
      return;
    }
    savingSection = 'password';
    try {
      if (supabaseEnabled) {
        await changeSupabasePassword({ currentPassword, newPassword });
      } else {
        await responseBody(await apiFetch(`${profileEndpoint}/password`, {
          method: 'PATCH',
          headers: { ...headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        }));
      }
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      notify('password', 'notice', 'Votre mot de passe a été changé.');
    } catch (passwordError) {
      notify('password', 'error', {
        CURRENT_PASSWORD_INVALID: 'Votre mot de passe actuel est incorrect.',
        PASSWORD_TOO_SHORT: 'Le mot de passe doit contenir au moins 10 caractères.',
      }[passwordError.message] ?? 'Le mot de passe n’a pas pu être changé. Vérifiez les champs et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function requestEmailChange(event) {
    event.preventDefault();
    savingSection = 'email';
    notify('', '', '');
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/email/request`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailDraft }),
      }));
      emailChallengeId = body.challengeId;
      demoEmailOtp = body.otp ?? '';
      notify('email', 'notice', body.delivery === 'email'
        ? `Un code de confirmation a été envoyé à ${body.recipient}.`
        : `Un code de confirmation a été préparé pour ${body.recipient}.`);
    } catch (emailRequestError) {
      notify('email', 'error', {
        EMAIL_ALREADY_IN_USE: 'Cette adresse e-mail est déjà associée à un autre compte.',
        OTP_SIMULATION_DISABLED: 'La confirmation d’e-mail est désactivée dans cet environnement.',
        EMAIL_DELIVERY_NOT_CONFIGURED: 'La vérification par e-mail n’est pas encore configurée.',
        EMAIL_RATE_LIMITED: 'Trop de codes ont été demandés. Réessayez dans une heure.',
        EMAIL_DELIVERY_FAILED: 'Le code n’a pas pu être envoyé. Réessayez plus tard.',
      }[emailRequestError.message] ?? 'La demande de changement d’e-mail a échoué. Vérifiez l’adresse et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function verifyEmailChange(event) {
    event.preventDefault();
    savingSection = 'email';
    notify('', '', '');
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
      notify('email', 'notice', 'Votre adresse e-mail a été confirmée et mise à jour.');
    } catch {
      notify('email', 'error', 'Le code est invalide ou expiré. Demandez un nouveau code et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function requestPhoneChange(event) {
    event.preventDefault();
    savingSection = 'phone';
    notify('', '', '');
    try {
      const body = await responseBody(await apiFetch(`${profileEndpoint}/phone/request`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phoneDraft }),
      }));
      phoneChallengeId = body.challengeId;
      demoPhoneOtp = body.otp ?? '';
      notify('phone', 'notice', `Un code de confirmation a été préparé pour ${body.recipient}.`);
    } catch (phoneRequestError) {
      notify('phone', 'error', {
        PHONE_INVALID: 'Saisissez un numéro mobile malgache valide.',
        PHONE_ALREADY_IN_USE: 'Ce numéro est déjà associé à un autre compte.',
        PHONE_UNCHANGED: 'Ce numéro est déjà enregistré sur votre compte.',
        OTP_SIMULATION_DISABLED: 'La confirmation du numéro est désactivée dans cet environnement.',
      }[phoneRequestError.message] ?? 'La demande de changement de numéro a échoué. Vérifiez le numéro et réessayez.');
    } finally {
      savingSection = '';
    }
  }

  async function verifyPhoneChange(event) {
    event.preventDefault();
    savingSection = 'phone';
    notify('', '', '');
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
      notify('phone', 'notice', 'Votre numéro de téléphone a été confirmé et mis à jour.');
    } catch (phoneVerificationError) {
      notify('phone', 'error', phoneVerificationError.message === 'PHONE_ALREADY_IN_USE'
        ? 'Ce numéro est déjà associé à un autre compte.'
        : 'Le code est invalide ou expiré. Demandez un nouveau code et réessayez.');
    } finally {
      savingSection = '';
    }
  }
</script>

{#snippet sectionFeedback(section)}
  {#if feedback.section === section && feedback.text}
    <p
      class={feedback.type === 'error' ? 'driver-account-settings__error' : 'driver-account-settings__notice'}
      role={feedback.type === 'error' ? 'alert' : 'status'}
    >{feedback.text}</p>
  {/if}
{/snippet}

<section id="account-settings" class="driver-account-settings" aria-label={role === 'driver' ? 'Véhicule et profil chauffeur' : 'Mon profil'}>
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
            {#if vehicle.registration}<span class="driver-vehicle-summary__plate">{vehicle.registration}</span>{/if}
            {#if vehicle.color}<span>{vehicle.color}</span>{/if}
          </div>
        </div>
      </article>
      {#if supabaseEnabled}
        <form class="driver-profile-form driver-profile-form--vehicle" onsubmit={saveVehicle}>
          <div class="driver-settings-form__heading">
            <h3>Modifier les détails</h3>
            <p>{vehicle.category === 'moto' ? 'Indiquez la marque et la couleur de votre moto.' : 'Marque, matricule et couleur sont obligatoires.'}</p>
          </div>
          <label>
            Marque
            <input bind:value={vehicleMake} maxlength="40" autocomplete="off" placeholder={vehicle.category === 'moto' ? 'Ex. Yamaha, Honda' : 'Ex. Toyota'} required />
          </label>
          <label>
            Modèle (facultatif)
            <input bind:value={vehicleModel} maxlength="40" autocomplete="off" placeholder={vehicle.category === 'moto' ? 'Ex. Jog, Wave' : 'Ex. Corolla'} />
          </label>
          {#if vehicle.category === 'voiture'}
            <label>
              Numéro matricule
              <input bind:value={vehicleRegistration} minlength="3" maxlength="20" autocomplete="off" placeholder="Ex. 1234 TAA" required />
            </label>
          {/if}
          <label>
            Couleur
            <input bind:value={vehicleColor} maxlength="30" autocomplete="off" placeholder="Ex. Rouge" required />
          </label>
          <button class="auth-secondary" type="submit" disabled={savingSection === 'vehicle'}>
            {savingSection === 'vehicle' ? 'Enregistrement…' : 'Enregistrer mon véhicule'}
          </button>
          {@render sectionFeedback('vehicle')}
        </form>
      {/if}
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
          {#if photoSource && !photoBroken}
            <img src={apiAssetUrl(photoSource)} alt="" onerror={() => { photoBroken = true; }} />
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
              <span>{photoBusy ? 'Préparation…' : 'Choisir une photo'}</span>
              <input
                class="driver-photo-picker__input"
                type="file"
                accept="image/*"
                disabled={photoBusy}
                onchange={handlePhotoChange}
              />
            </label>
            {#if photoDraft || (profile.photoUrl && !removePhoto)}
              <button type="button" class="driver-profile-form__remove-photo" onclick={discardPhoto}>
                {photoDraft ? 'Annuler ce choix' : 'Supprimer la photo'}
              </button>
            {/if}
            {#if photoError}<p class="driver-account-settings__error" role="alert">{photoError}</p>{/if}
          </div>
        </div>
        <label>
          Nom
          <input bind:value={profileName} minlength="2" maxlength="80" autocomplete="name" required />
        </label>
        <button class="auth-secondary" type="submit" disabled={savingSection === 'identity' || photoBusy}>
          {savingSection === 'identity' ? 'Enregistrement…' : 'Enregistrer mon profil'}
        </button>
        {@render sectionFeedback('identity')}
      </form>

      {#if supabaseEnabled}
        <form class="driver-profile-form driver-profile-form--phone" onsubmit={savePhone}>
          <div class="driver-settings-form__heading">
            <h3>Numéro de téléphone</h3>
            <p>Numéro actuel : <strong>{profile.phone}</strong>. Il sert aussi à vous connecter.</p>
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
              placeholder="034 00 000 01"
              required
            />
          </label>
          <PasswordField id="account-phone-password" label="Mot de passe actuel" bind:value={phonePassword} />
          <button class="auth-secondary" type="submit" disabled={savingSection === 'phone'}>
            {savingSection === 'phone' ? 'Enregistrement…' : 'Changer mon numéro'}
          </button>
          {@render sectionFeedback('phone')}
        </form>
      {:else}
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
            <button class="auth-secondary" type="submit" disabled={savingSection === 'phone'}>
              {savingSection === 'phone' ? 'Vérification…' : phoneChallengeId ? 'Confirmer mon numéro' : 'Vérifier ce numéro'}
            </button>
            {@render sectionFeedback('phone')}
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
          <button class="auth-secondary" type="submit" disabled={savingSection === 'email'}>
            {savingSection === 'email' ? 'Vérification…' : emailChallengeId ? 'Confirmer mon e-mail' : 'Vérifier cette adresse'}
          </button>
          {@render sectionFeedback('email')}
        </form>
      {/if}

      <form class="driver-profile-form driver-profile-form--password" onsubmit={changePassword}>
        <div class="driver-settings-form__heading">
          <h3>Mot de passe</h3>
          <p>Choisissez un mot de passe d’au moins 10 caractères.</p>
        </div>
        <div class="driver-password-fields">
          <PasswordField id="account-current-password" label="Mot de passe actuel" bind:value={currentPassword} />
          <PasswordField id="account-new-password" label="Nouveau mot de passe" bind:value={newPassword} autocomplete="new-password" minlength="10" />
          <PasswordField id="account-confirm-password" label="Confirmer le nouveau mot de passe" bind:value={confirmPassword} autocomplete="new-password" minlength="10" />
        </div>
        <button class="auth-secondary" type="submit" disabled={savingSection === 'password'}>
          {savingSection === 'password' ? 'Enregistrement…' : 'Mettre à jour le mot de passe'}
        </button>
        {@render sectionFeedback('password')}
      </form>

      {#if onlogout}
        <div class="driver-account-settings__logout">
          <button class="auth-logout-button" type="button" onclick={onlogout}>
            Se déconnecter
          </button>
        </div>
      {/if}
    </div>
  </section>
</section>
