<script>
  import AccountSettings from './AccountSettings.svelte';
  import { apiAssetUrl, apiFetch } from './lib/api.js';
  import { supabaseEnabled } from './lib/supabase.js';

  let { token, profile, onlogout, onprofilechange } = $props();
  let adminProfile = $state({ id: '', name: '', photoUrl: null, role: 'admin' });
  let summary = $state(null);
  let accounts = $state([]);
  let operations = $state(null);
  let loading = $state(true);
  let error = $state('');
  let busyAccountId = $state('');
  let notice = $state('');
  let search = $state('');
  let roleFilter = $state('all');
  let statusFilter = $state('all');
  let activeTab = $state('accounts');
  let profileOpen = $state(false);
  let AccountSettingsView = $state(null);
  let newAdmin = $state({ name: '', phone: '', email: '', password: '' });
  let creatingAdmin = $state(false);

  const headers = () => ({ authorization: `Bearer ${token}` });
  $effect(() => {
    if (profile?.id && !adminProfile.id) {
      adminProfile = { ...profile };
    }
  });
  const filteredAccounts = $derived(accounts.filter((account) => {
    const query = search.trim().toLocaleLowerCase('fr');
    const matchesQuery = !query
      || [account.name, account.phone, account.email, account.vehicleRegistration]
        .some((value) => value?.toLocaleLowerCase('fr').includes(query));
    const matchesRole = roleFilter === 'all' || account.role === roleFilter;
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' ? account.isActive : !account.isActive);
    return matchesQuery && matchesRole && matchesStatus;
  }));

  async function responseBody(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    return body;
  }

  async function loadDashboard() {
    loading = true;
    error = '';
    try {
      const [summaryBody, accountBody, operationsBody] = await Promise.all([
        apiFetch('/api/admin/summary', { headers: headers() }).then(responseBody),
        apiFetch('/api/admin/accounts', { headers: headers() }).then(responseBody),
        apiFetch('/api/admin/operations', { headers: headers() }).then(responseBody),
      ]);
      summary = summaryBody;
      accounts = accountBody.accounts;
      operations = operationsBody;
    } catch {
      error = 'Le tableau de bord ne peut pas être chargé. Vérifiez la connexion puis réessayez.';
    } finally {
      loading = false;
    }
  }

  async function setAccountActive(account) {
    if (busyAccountId) return;
    const isActive = !account.isActive;
    if (!isActive) {
      const message = account.role === 'passenger'
        ? `Désactiver le compte de ${account.name} ? Ses demandes de course ouvertes seront annulées.`
        : `Désactiver le compte de ${account.name} ? Il sera mis hors ligne et ses offres en attente seront retirées.`;
      if (!window.confirm(message)) return;
    }
    busyAccountId = account.id;
    error = '';
    notice = '';
    try {
      await responseBody(await apiFetch(
        `/api/admin/accounts/${encodeURIComponent(account.id)}/status`,
        {
          method: 'PATCH',
          headers: {
            ...headers(),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ isActive }),
        },
      ));
      notice = isActive
        ? `Le compte de ${account.name} est réactivé.`
        : `Le compte de ${account.name} est désactivé.`;
      await loadDashboard();
    } catch (requestError) {
      error = requestError.message === 'ACCOUNT_HAS_ACTIVE_RIDE'
        ? 'Ce compte est associé à une course confirmée ou en cours. Terminez-la avant de le désactiver.'
        : 'Le statut du compte n’a pas pu être modifié.';
    } finally {
      busyAccountId = '';
    }
  }

  async function deleteAccount(account) {
    if (busyAccountId) return;
    const message = `Supprimer définitivement le compte de ${account.name} ? Cette action supprimera l’intégralité de ses données et est irréversible.`;
    if (!window.confirm(message)) return;
    busyAccountId = account.id;
    error = '';
    notice = '';
    try {
      await responseBody(await apiFetch(
        `/api/admin/accounts/${encodeURIComponent(account.id)}`,
        {
          method: 'DELETE',
          headers: headers(),
        },
      ));
      notice = `Le compte de ${account.name} a été supprimé définitivement.`;
      await loadDashboard();
    } catch (requestError) {
      error = requestError.message === 'ACCOUNT_HAS_ACTIVE_RIDE'
        ? 'Ce compte est associé à une course confirmée ou en cours. Impossible de le supprimer pour le moment.'
        : 'Le compte n’a pas pu être supprimé.';
    } finally {
      busyAccountId = '';
    }
  }

  async function openProfile() {
    profileOpen = !profileOpen;
    if (!profileOpen || AccountSettingsView) return;
    try {
      AccountSettingsView = (await import('./AccountSettings.svelte')).default;
    } catch {
      error = 'Le profil ne peut pas être chargé. Actualisez la page puis réessayez.';
      profileOpen = false;
    }
  }

  async function createAdmin(event) {
    event.preventDefault();
    if (creatingAdmin) return;
    creatingAdmin = true;
    error = '';
    notice = '';
    try {
      const body = await responseBody(await apiFetch('/api/admin/accounts', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newAdmin.name,
          phone: newAdmin.phone,
          ...(newAdmin.email.trim() ? { email: newAdmin.email } : {}),
          password: newAdmin.password,
        }),
      }));
      notice = `Le compte administrateur de ${body.account.name} a été créé.`;
      newAdmin = { name: '', phone: '', email: '', password: '' };
      await loadDashboard();
    } catch (requestError) {
      error = {
        PHONE_INVALID: 'Saisissez un numéro mobile malgache valide.',
        PHONE_ALREADY_EXISTS: 'Un compte utilise déjà ce numéro.',
        PHONE_ALREADY_IN_USE: 'Un compte utilise déjà ce numéro.',
        EMAIL_INVALID: 'Saisissez une adresse e-mail valide.',
        EMAIL_ALREADY_EXISTS: 'Un compte utilise déjà cette adresse e-mail.',
        PASSWORD_TOO_SHORT: 'Le mot de passe doit comporter au moins 10 caractères.',
      }[requestError.message] ?? 'Le compte administrateur n’a pas pu être créé.';
    } finally {
      creatingAdmin = false;
    }
  }

  function roleLabel(role) {
    return { driver: 'Chauffeur', passenger: 'Passager', admin: 'Administrateur' }[role] ?? role;
  }

  function vehicleLabel(account) {
    return [account.vehicleMake, account.vehicleModel, account.vehicleColor]
      .filter(Boolean)
      .join(' · ');
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
  }

  function formatPrice(amount) {
    return amount === null || amount === undefined
      ? '—'
      : `${new Intl.NumberFormat('fr-FR').format(amount)} Ar`;
  }

  function rideStatusLabel(status) {
    return {
      searching: 'Recherche',
      negotiating: 'Négociation',
      driver_en_route: 'Chauffeur en route',
      driver_arrived: 'Chauffeur arrivé',
      in_progress: 'En cours',
      completed: 'Terminée',
      cancelled: 'Annulée',
    }[status] ?? status;
  }

  void loadDashboard();
</script>

<main class="driver-app admin-app">
  <header class="driver-app__topline">
    <div class="welcome__brand">
      <img
        class="welcome__logo"
        src="/logo-drivenight.webp"
        alt="DriveNight"
        width="960"
        height="228"
      />
    </div>
    <div class="driver-app__account">
      {#if adminProfile.photoUrl}
        <img src={apiAssetUrl(adminProfile.photoUrl)} alt="" class="account-summary__photo" />
      {:else}
        <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
          {adminProfile.name.slice(0, 1).toUpperCase()}
        </span>
      {/if}
      <div>
        <strong>{adminProfile.name}</strong>
        <span>Administration</span>
      </div>
      <button class="auth-secondary" type="button" aria-pressed={profileOpen} onclick={openProfile}>
        {profileOpen ? 'Fermer le profil' : 'Mon profil'}
      </button>
    </div>
  </header>

  <section class="admin-dashboard" aria-labelledby="admin-title">
    <div class="admin-dashboard__intro">
      <div>
        <p class="driver-dashboard__eyebrow">Espace administration</p>
        <h1 id="admin-title">Vue d’ensemble.</h1>
        <p class="driver-dashboard__lead">Gérez les comptes et suivez l’activité locale de DriveNight.</p>
      </div>
      <button class="driver-refresh" type="button" disabled={loading} onclick={loadDashboard}>
        {loading ? 'Actualisation…' : 'Actualiser'}
      </button>
    </div>

    {#if error}
      <p class="admin-dashboard__error" role="alert">{error}</p>
      {#if !loading}
        <button class="driver-refresh" type="button" onclick={loadDashboard}>Réessayer</button>
      {/if}
    {/if}
    {#if notice}
      <p class="admin-dashboard__notice" role="status">{notice}</p>
    {/if}

    {#if profileOpen}
      {#if AccountSettingsView}
        <section class="admin-profile" aria-label="Profil administrateur">
          <button class="admin-profile__back" type="button" onclick={() => { profileOpen = false; }}>
            Retour au tableau de bord
          </button>
          <AccountSettingsView
            {token}
            profile={adminProfile}
            role="admin"
            onprofilechange={(nextProfile) => {
              adminProfile = nextProfile;
              onprofilechange?.(nextProfile);
            }}
            onlogout={onlogout}
          />
        </section>
      {:else}
        <p class="passenger-app__loading" role="status">Chargement du profil…</p>
      {/if}
    {:else if loading && !summary}
      <p class="passenger-app__loading" role="status">Chargement du tableau de bord…</p>
    {:else if summary}
      <div class="admin-stats" aria-label="Statistiques DriveNight">
        <article class="admin-stat">
          <span>Comptes</span>
          <strong>{summary.users.total}</strong>
          <small>{summary.users.passengers} passagers · {summary.users.drivers} chauffeurs</small>
        </article>
        <article class="admin-stat">
          <span>Comptes actifs</span>
          <strong>{summary.users.active}</strong>
          <small>{summary.users.inactive} désactivé{summary.users.inactive > 1 ? 's' : ''}</small>
        </article>
        <article class="admin-stat">
          <span>Courses actives</span>
          <strong>{summary.rides.searching + summary.rides.negotiating + summary.rides.driver_en_route + summary.rides.driver_arrived + summary.rides.in_progress}</strong>
          <small>{summary.rides.total} courses au total</small>
        </article>
        <article class="admin-stat">
          <span>Courses terminées</span>
          <strong>{summary.rides.completed}</strong>
          <small>{summary.rides.cancelled} annulées</small>
        </article>
      </div>

      <nav class="admin-sections" aria-label="Outils d’administration">
        <button type="button" class:admin-sections__tab--active={activeTab === 'accounts'} aria-pressed={activeTab === 'accounts'} onclick={() => { activeTab = 'accounts'; }}>Comptes</button>
        <button type="button" class:admin-sections__tab--active={activeTab === 'requests'} aria-pressed={activeTab === 'requests'} onclick={() => { activeTab = 'requests'; }}>Demandes</button>
        <button type="button" class:admin-sections__tab--active={activeTab === 'availability'} aria-pressed={activeTab === 'availability'} onclick={() => { activeTab = 'availability'; }}>Présence</button>
        <button type="button" class:admin-sections__tab--active={activeTab === 'history'} aria-pressed={activeTab === 'history'} onclick={() => { activeTab = 'history'; }}>Courses et avis</button>
        <button type="button" class:admin-sections__tab--active={activeTab === 'admins'} aria-pressed={activeTab === 'admins'} onclick={() => { activeTab = 'admins'; }}>Administrateurs</button>
      </nav>

      {#if activeTab === 'accounts'}
      <section class="admin-accounts" aria-labelledby="admin-accounts-title">
        <div class="admin-accounts__heading">
          <div>
            <p class="ride-history__eyebrow">Gestion des accès</p>
            <h2 id="admin-accounts-title">Comptes passagers et chauffeurs</h2>
          </div>
          <span>{filteredAccounts.length} résultat{filteredAccounts.length > 1 ? 's' : ''}</span>
        </div>

        <div class="admin-account-filters" role="search">
          <label class="admin-account-filters__search">
            <span>Rechercher un compte</span>
            <input
              type="search"
              bind:value={search}
              placeholder="Nom, téléphone, e-mail ou véhicule"
            />
          </label>
          <label>
            <span>Type de compte</span>
            <select bind:value={roleFilter}>
              <option value="all">Tous les rôles</option>
              <option value="passenger">Passagers</option>
              <option value="driver">Chauffeurs</option>
              <option value="admin">Administrateurs</option>
            </select>
          </label>
          <label>
            <span>État</span>
            <select bind:value={statusFilter}>
              <option value="all">Tous</option>
              <option value="active">Actifs</option>
              <option value="inactive">Désactivés</option>
            </select>
          </label>
        </div>

        {#if loading}
          <p class="admin-accounts__empty" role="status">Actualisation des comptes…</p>
        {:else if filteredAccounts.length}
          <div class="admin-accounts__list">
            {#each filteredAccounts as account (account.id)}
              <article class="admin-account" class:admin-account--inactive={!account.isActive}>
                <div class="admin-account__identity">
                  {#if account.photoUrl}
                    <img src={apiAssetUrl(account.photoUrl)} alt="" class="account-summary__photo" />
                  {:else}
                    <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
                      {account.name.slice(0, 1).toUpperCase()}
                    </span>
                  {/if}
                  <div>
                    <strong>{account.name}</strong>
                    <span>{roleLabel(account.role)} · Inscrit le {formatDate(account.createdAt)}</span>
                  </div>
                </div>
                <div class="admin-account__details">
                  <span>{account.phone}</span>
                  {#if account.email}<span>{account.email}</span>{/if}
                  {#if account.role === 'driver'}
                    <span>
                      {account.vehicleCategory} · {account.vehicleRegistration}
                      {#if vehicleLabel(account)} · {vehicleLabel(account)}{/if}
                    </span>
                    <span>★ {account.averageRating.toFixed(1)} ({account.ratingCount} avis) · {account.isOnline ? 'En ligne' : 'Hors ligne'}</span>
                  {:else}
                    <span>★ {account.averageRating.toFixed(1)} ({account.ratingCount} avis)</span>
                  {/if}
                </div>
                <span class="admin-account__status" class:admin-account__status--inactive={!account.isActive}>
                  {account.isActive ? 'Actif' : 'Désactivé'}
                </span>
                <div class="admin-account__actions">
                  {#if account.id !== adminProfile.id}
                    <button
                      class="admin-account__action"
                      class:admin-account__action--enable={!account.isActive}
                      type="button"
                      disabled={Boolean(busyAccountId)}
                      aria-label={`${account.isActive ? 'Désactiver' : 'Réactiver'} le compte de ${account.name}`}
                      onclick={() => setAccountActive(account)}
                    >
                      {busyAccountId === account.id
                        ? 'Mise à jour…'
                        : account.isActive ? 'Désactiver' : 'Réactiver'}
                    </button>
                    <button
                      class="admin-account__action admin-account__action--delete"
                      type="button"
                      disabled={Boolean(busyAccountId)}
                      aria-label={`Supprimer définitivement le compte de ${account.name}`}
                      onclick={() => deleteAccount(account)}
                    >
                      Supprimer
                    </button>
                  {:else}
                    <span class="admin-account__status">Votre compte (connecté)</span>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <p class="admin-accounts__empty">Aucun compte ne correspond à ces filtres.</p>
        {/if}
      </section>
      {:else if activeTab === 'requests'}
        <section class="admin-operations" aria-labelledby="admin-requests-title">
          <div class="admin-accounts__heading">
            <div>
              <p class="ride-history__eyebrow">En temps réel</p>
              <h2 id="admin-requests-title">Demandes ouvertes</h2>
            </div>
            <span>{operations?.requests.length ?? 0} demande{operations?.requests.length === 1 ? '' : 's'}</span>
          </div>
          {#if operations?.requests.length}
            <div class="admin-operations__list">
              {#each operations.requests as ride (ride.id)}
                <article class="admin-operation">
                  <div class="admin-operation__route">
                    <strong>{ride.origin}</strong>
                    <span>vers</span>
                    <strong>{ride.destination}</strong>
                  </div>
                  <div class="admin-operation__meta">
                    <span>{ride.category} · {rideStatusLabel(ride.status)}</span>
                    <span>Prix proposé : {formatPrice(ride.proposedPriceMGA)}</span>
                    <span>{ride.pendingOfferCount} offre{ride.pendingOfferCount === 1 ? '' : 's'} en attente</span>
                    <span>Passager : {ride.passenger.name} · {ride.passenger.phone}</span>
                  </div>
                  <time>{formatDate(ride.requestedAt)}</time>
                </article>
              {/each}
            </div>
          {:else}
            <p class="admin-accounts__empty">Aucune demande ouverte pour le moment.</p>
          {/if}
        </section>
      {:else if activeTab === 'availability'}
        <section class="admin-operations" aria-labelledby="admin-presence-title">
          <div class="admin-accounts__heading">
            <div>
              <p class="ride-history__eyebrow">Dernière activité · moins de 90 secondes</p>
              <h2 id="admin-presence-title">Présence des comptes</h2>
            </div>
          </div>
          <div class="admin-presence">
            <section>
              <h3>Chauffeurs en ligne</h3>
              <p>{operations?.onlineDrivers.filter((driver) => driver.available).length ?? 0} disponibles</p>
              {#if operations?.onlineDrivers.length}
                <div class="admin-operations__list">
                  {#each operations.onlineDrivers as driver (driver.id)}
                    <article class="admin-operation admin-operation--compact">
                      <strong>{driver.name}</strong>
                      <span>{driver.vehicleCategory} · {driver.vehicleRegistration}</span>
                      <span>★ {driver.averageRating.toFixed(1)} ({driver.ratingCount} avis)</span>
                      <span class:admin-presence__available={driver.available}>{driver.available ? 'Disponible' : 'En course'}</span>
                    </article>
                  {/each}
                </div>
              {:else}
                <p class="admin-accounts__empty">Aucun chauffeur en ligne.</p>
              {/if}
            </section>
            <section>
              <h3>Passagers connectés</h3>
              <p>{operations?.onlinePassengers.length ?? 0} actuellement en ligne</p>
              {#if operations?.onlinePassengers.length}
                <div class="admin-operations__list">
                  {#each operations.onlinePassengers as passenger (passenger.id)}
                    <article class="admin-operation admin-operation--compact">
                      <strong>{passenger.name}</strong>
                      <span>{passenger.phone}</span>
                      <span class="admin-presence__available">En ligne</span>
                    </article>
                  {/each}
                </div>
              {:else}
                <p class="admin-accounts__empty">Aucun passager connecté pour le moment.</p>
              {/if}
            </section>
          </div>
        </section>
      {:else if activeTab === 'history'}
        <section class="admin-operations" aria-labelledby="admin-history-title">
          <div class="admin-accounts__heading">
            <div>
              <p class="ride-history__eyebrow">Toutes les courses</p>
              <h2 id="admin-history-title">Historique et évaluations</h2>
            </div>
            <span>{operations?.history.length ?? 0} courses · {operations?.ratings.length ?? 0} avis</span>
          </div>
          <div class="admin-history">
            <section>
              <h3>Historique des courses</h3>
              <div class="admin-operations__list">
                {#each operations?.history ?? [] as ride (ride.id)}
                  <article class="admin-operation">
                    <div class="admin-operation__route">
                      <strong>{ride.origin}</strong><span>vers</span><strong>{ride.destination}</strong>
                    </div>
                    <div class="admin-operation__meta">
                      <span>{rideStatusLabel(ride.status)} · {ride.category}</span>
                      <span>{ride.passengerName} → {ride.driverName ?? 'Aucun chauffeur'}</span>
                      <span>Prix convenu : {formatPrice(ride.agreedPriceMGA ?? ride.proposedPriceMGA)}</span>
                    </div>
                    <time>{formatDate(ride.completedAt ?? ride.cancelledAt ?? ride.requestedAt)}</time>
                  </article>
                {/each}
              </div>
            </section>
            <section>
              <h3>Avis reçus</h3>
              {#if operations?.ratings.length}
                <div class="admin-operations__list">
                  {#each operations.ratings as rating (rating.id)}
                    <article class="admin-operation">
                      <div class="admin-rating" aria-label={`${rating.stars} étoiles sur 5`}>
                        {#each [1, 2, 3, 4, 5] as star}
                          <span class:admin-rating__empty={star > rating.stars} aria-hidden="true">★</span>
                        {/each}
                      </div>
                      <div class="admin-operation__meta">
                        <span>{rating.raterName} a évalué {rating.rateeName}</span>
                        <span>{rating.origin} vers {rating.destination}</span>
                        {#if rating.comment}<q>{rating.comment}</q>{/if}
                      </div>
                      <time>{formatDate(rating.createdAt)}</time>
                    </article>
                  {/each}
                </div>
              {:else}
                <p class="admin-accounts__empty">Aucun avis n’a encore été publié.</p>
              {/if}
            </section>
          </div>
        </section>
      {:else}
        <section class="admin-accounts" aria-labelledby="admin-create-title">
          <div class="admin-accounts__heading">
            <div>
              <p class="ride-history__eyebrow">Accès de confiance</p>
              <h2 id="admin-create-title">Créer un compte administrateur</h2>
            </div>
          </div>
          <form class="admin-create-form" onsubmit={createAdmin}>
            <label>Nom<input bind:value={newAdmin.name} minlength="2" maxlength="80" autocomplete="name" required /></label>
            <label>Téléphone<input bind:value={newAdmin.phone} type="tel" autocomplete="tel" inputmode="tel" placeholder="034 00 000 01" required /></label>
            <label>E-mail <span>(facultatif)</span><input bind:value={newAdmin.email} type="email" autocomplete="email" maxlength="254" /></label>
            <label>Mot de passe temporaire<input bind:value={newAdmin.password} type="password" minlength="10" maxlength="128" autocomplete="new-password" required /></label>
            <button class="auth-submit" type="submit" disabled={creatingAdmin}>{creatingAdmin ? 'Création…' : 'Créer l’administrateur'}</button>
          </form>
          <div class="admin-accounts__heading">
            <h2>Administrateurs</h2>
            <span>{accounts.filter((account) => account.role === 'admin').length}</span>
          </div>
          <div class="admin-accounts__list">
            {#each accounts.filter((account) => account.role === 'admin') as account (account.id)}
              <article class="admin-operation admin-operation--compact">
                <div class="admin-operation__identity">
                  <strong>{account.name}{account.id === adminProfile.id ? ' (vous)' : ''}</strong>
                  <span>{account.phone}</span>
                  {#if account.email}<span>{account.email}</span>{/if}
                  <span>{account.isActive ? 'Actif' : 'Désactivé'}</span>
                </div>
                {#if account.id !== adminProfile.id}
                  <div class="admin-account__actions">
                    <button
                      class="admin-account__action"
                      class:admin-account__action--enable={!account.isActive}
                      type="button"
                      disabled={Boolean(busyAccountId)}
                      onclick={() => setAccountActive(account)}
                    >
                      {busyAccountId === account.id ? 'Mise à jour…' : account.isActive ? 'Désactiver' : 'Réactiver'}
                    </button>
                    <button
                      class="admin-account__action admin-account__action--delete"
                      type="button"
                      disabled={Boolean(busyAccountId)}
                      onclick={() => deleteAccount(account)}
                    >
                      Supprimer
                    </button>
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </section>
</main>
