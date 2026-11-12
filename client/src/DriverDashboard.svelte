<script>
  import { onMount, untrack } from 'svelte';
  import AccountSettings from './AccountSettings.svelte';
  import RideHistory from './RideHistory.svelte';
  import { apiAssetUrl, apiFetch, apiRealtimeConnect } from './lib/api.js';
  import { geolocationErrorMessage, requestCurrentPosition } from './lib/geolocation.js';
  import { supabaseEnabled } from './lib/supabase.js';

  let { token, profile, onlogout } = $props();
  let driverProfile = $state.raw(untrack(() => ({ ...profile })));
  let profileSettingsOpen = $state(false);
  let mapElement = $state(null);
  let map;
  let leaflet;
  let markerLayer;
  let routeLayer;
  let userLocationLayer;
  let driverSelfLocation = $state(null);
  let locatingSelf = $state(false);
  let mapLocateMessage = $state('');
  let mapReady = $state(false);
  let mapError = $state('');
  let isOnline = $state(false);
  let rides = $state([]);
  let activeRides = $state([]);
  let pendingOffers = $state([]);
  let rideStats = $state({ completedToday: 0, completedThisWeek: 0 });
  let dashboardNow = $state(Date.now());
  let activeMessages = $state({});
  let activeDrafts = $state({});
  let activeChatErrors = $state({});
  let sendingChatRideId = $state('');
  let statusBusyRideId = $state('');
  let rideStatusNotice = $state('');
  let locationSharingRideId = $state('');
  let locationErrors = $state({});
  const activeChatRequests = new Set();
  let loading = $state(true);
  let availabilityBusy = $state(false);
  let submittingRideId = $state('');
  let acceptingRideId = $state('');
  let error = $state('');
  let refreshedAt = $state('');
  let offerAmounts = $state({});
  let rideMessages = $state({});
  let refreshingRides = false;
  let realtimeSocket;
  let realtimeConnecting = false;
  let realtimeReconnectTimer;
  let geolocationWatchId = null;
  let lastLocationSentAt = 0;

  const headers = () => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });

  async function responseBody(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    return body;
  }

  function pendingOfferSecondsRemaining(offer) {
    return Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - dashboardNow) / 1000));
  }

  async function advanceRideStatus(ride) {
    const nextStatus = {
      driver_en_route: 'driver_arrived',
      driver_arrived: 'in_progress',
      in_progress: 'completed',
    }[ride.status];
    if (!nextStatus || statusBusyRideId) return;
    statusBusyRideId = ride.id;
    rideStatusNotice = '';
    try {
      const body = await responseBody(await apiFetch(
        `/api/rides/${encodeURIComponent(ride.id)}/status`,
        {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ status: nextStatus }),
        },
      ));
      activeRides = activeRides.map((item) => item.id === ride.id ? body.ride : item);
      rideStatusNotice = nextStatus === 'completed'
        ? 'Course terminée.'
        : 'Statut de la course mis à jour.';
      if (nextStatus === 'completed') {
        stopLocationSharing(ride.id);
        await refreshActiveRides();
      }
    } catch (requestError) {
      rideStatusNotice = requestError.message === 'RIDE_STATUS_TRANSITION_INVALID'
        ? 'Le statut a changé. Actualisez vos courses avant de continuer.'
        : 'Le statut de la course n’a pas pu être mis à jour.';
    } finally {
      statusBusyRideId = '';
    }
  }

  async function cancelActiveRide(ride) {
    if (statusBusyRideId || !window.confirm('Êtes-vous sûr de vouloir annuler cette course ? Le passager en sera informé.')) return;
    statusBusyRideId = ride.id;
    rideStatusNotice = '';
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(ride.id)}/cancel`, {
        method: 'POST',
        headers: headers(),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RIDE_CANCELLATION_FAILED');
      stopLocationSharing(ride.id);
      rideStatusNotice = 'Course annulée.';
      await refreshActiveRides();
      if (isOnline) await refreshRides();
    } catch {
      rideStatusNotice = 'La course n’a pas pu être annulée. Réessayez.';
    } finally {
      statusBusyRideId = '';
    }
  }

  function stopLocationSharing(rideId = locationSharingRideId) {
    if (!rideId || rideId !== locationSharingRideId) return;
    if (geolocationWatchId !== null) {
      navigator.geolocation.clearWatch(geolocationWatchId);
      geolocationWatchId = null;
    }
    locationSharingRideId = '';
  }

  function openProfileSettings() {
    profileSettingsOpen = true;
  }

  async function locateOnMap() {
    if (!mapReady || locatingSelf) return;
    locatingSelf = true;
    mapLocateMessage = 'Localisation de votre position en cours…';
    mapError = '';
    try {
      const coords = await requestCurrentPosition();
      driverSelfLocation = coords;
      drawDriverSelfLocation();
      map?.setView([coords.latitude, coords.longitude], 16);
      mapLocateMessage = 'Carte centrée sur votre position actuelle.';
    } catch (geoError) {
      mapLocateMessage = geolocationErrorMessage(geoError);
    } finally {
      locatingSelf = false;
    }
  }

  function drawDriverSelfLocation() {
    if (!map || !leaflet || !userLocationLayer) return;
    userLocationLayer.clearLayers();
    if (!driverSelfLocation) return;
    const content = document.createElement('span');
    content.textContent = 'Ma position actuelle';
    leaflet.marker([driverSelfLocation.latitude, driverSelfLocation.longitude], {
      icon: leaflet.divIcon({
        className: 'ride-map__marker',
        html: '<span class="ride-map__pin ride-map__pin--self"></span>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      title: 'Ma position actuelle',
    }).bindPopup(leaflet.popup().setContent(content)).addTo(userLocationLayer);
  }

  async function sendCurrentLocation(rideId, position) {
    driverSelfLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
    drawDriverSelfLocation();
    const now = Date.now();
    if (rideId !== locationSharingRideId || now - lastLocationSentAt < 5_000) return;
    lastLocationSentAt = now;
    try {
      await responseBody(await apiFetch(`/api/rides/${encodeURIComponent(rideId)}/location`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      }));
      locationErrors[rideId] = '';
    } catch {
      locationErrors[rideId] = 'La position n’a pas pu être envoyée. Vérifiez la connexion.';
    }
  }

  function toggleLocationSharing(ride) {
    if (locationSharingRideId === ride.id) {
      stopLocationSharing(ride.id);
      locationErrors[ride.id] = '';
      return;
    }
    if (!navigator.geolocation) {
      locationErrors[ride.id] = 'La géolocalisation n’est pas disponible dans ce navigateur.';
      return;
    }
    stopLocationSharing();
    locationSharingRideId = ride.id;
    locationErrors[ride.id] = '';
    lastLocationSentAt = 0;
    geolocationWatchId = navigator.geolocation.watchPosition(
      (position) => { void sendCurrentLocation(ride.id, position); },
      (geoError) => {
        locationErrors[ride.id] = geoError.code === geoError.PERMISSION_DENIED
          ? 'Autorisez la géolocalisation pour partager votre position avec le passager.'
          : 'La position GPS est temporairement indisponible.';
        if (geoError.code === geoError.PERMISSION_DENIED) stopLocationSharing(ride.id);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
    );
  }

  async function refreshRides() {
    if (!isOnline || refreshingRides) return;
    refreshingRides = true;
    try {
      const body = await responseBody(await apiFetch('/api/driver/rides', {
        headers: headers(),
      }));
      rides = activeRides.length ? [] : body.rides;
      subscribeToVisibleRides();
      refreshedAt = new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      error = '';
    } catch {
      error = 'Les demandes ne peuvent pas être actualisées. Vérifiez votre connexion puis réessayez.';
    } finally {
      refreshingRides = false;
      loading = false;
    }
  }

  function subscribeToVisibleRides(socket = realtimeSocket) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const ride of [
      ...rides,
      ...activeRides,
      ...pendingOffers.map((offer) => offer.ride),
    ]) {
      socket.send(JSON.stringify({ type: 'subscribe', rideId: ride.id }));
    }
  }

  async function refreshActiveRides() {
    try {
      const body = await responseBody(await apiFetch('/api/driver/active-rides', {
        headers: headers(),
      }));
      activeRides = body.rides;
      pendingOffers = body.pendingOffers ?? [];
      rideStats = body.stats ?? { completedToday: 0, completedThisWeek: 0 };
      if (activeRides.length) rides = [];
      subscribeToVisibleRides();
      await Promise.all(activeRides.map((ride) => loadActiveChat(ride.id)));
    } catch {
      error = 'Vos courses confirmées ne peuvent pas être actualisées.';
    }
  }

  async function loadActiveChat(rideId) {
    if (activeChatRequests.has(rideId)) return;
    activeChatRequests.add(rideId);
    try {
      const body = await responseBody(await apiFetch(
        `/api/rides/${encodeURIComponent(rideId)}/messages`,
        { headers: headers() },
      ));
      activeMessages[rideId] = body.messages;
      activeChatErrors[rideId] = '';
    } catch {
      activeChatErrors[rideId] = 'La conversation ne peut pas être actualisée.';
    } finally {
      activeChatRequests.delete(rideId);
    }
  }

  function addActiveMessage(rideId, message) {
    const messages = activeMessages[rideId] ?? [];
    if (messages.some((item) => item.id === message.id)) return;
    activeMessages[rideId] = [...messages, message];
  }

  async function sendActiveMessage(ride, event) {
    event.preventDefault();
    const body = (activeDrafts[ride.id] ?? '').trim();
    if (!body || sendingChatRideId) return;
    sendingChatRideId = ride.id;
    activeChatErrors[ride.id] = '';
    try {
      const result = await responseBody(await apiFetch(
        `/api/rides/${encodeURIComponent(ride.id)}/messages`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ body }),
        },
      ));
      addActiveMessage(ride.id, result.message);
      activeDrafts[ride.id] = '';
    } catch (requestError) {
      activeChatErrors[ride.id] = requestError.message === 'RIDE_CHAT_NOT_ACTIVE'
        ? 'La course est terminée ; vous ne pouvez plus envoyer de message.'
        : 'Votre message n’a pas pu être envoyé. Réessayez.';
    } finally {
      sendingChatRideId = '';
    }
  }

  async function loadDashboard() {
    loading = true;
    error = '';
    try {
      const status = await responseBody(await apiFetch('/api/driver/availability', {
        headers: headers(),
      }));
      isOnline = status.isOnline;
      rides = [];
      await refreshActiveRides();
      loading = false;
      await refreshRides();
      if (isOnline || activeRides.length) void connectRealtime();
    } catch {
      loading = false;
      error = 'Votre espace chauffeur ne peut pas être chargé. Actualisez la page pour réessayer.';
    }
  }

  async function changeAvailability() {
    availabilityBusy = true;
    error = '';
    try {
      const body = await responseBody(await apiFetch('/api/driver/availability', {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ online: !isOnline }),
      }));
      isOnline = body.isOnline;
      rides = [];
      if (isOnline) {
        await refreshRides();
        void connectRealtime();
      } else {
        if (!activeRides.length) {
          realtimeSocket?.close();
          realtimeSocket = null;
          window.clearTimeout(realtimeReconnectTimer);
        }
      }
    } catch (requestError) {
      error = 'Votre disponibilité n’a pas pu être mise à jour. Réessayez.';
    } finally {
      availabilityBusy = false;
    }
  }

  async function submitOffer(ride) {
    const amountMGA = Number(offerAmounts[ride.id] ?? ride.proposedPriceMGA);
    if (!Number.isSafeInteger(amountMGA) || amountMGA < 1) {
      rideMessages[ride.id] = { error: 'Saisissez un montant valide en ariary.' };
      return;
    }

    submittingRideId = ride.id;
    rideMessages[ride.id] = null;
    try {
      await responseBody(await apiFetch(`/api/rides/${encodeURIComponent(ride.id)}/offers`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          amountMGA,
          respondsToOfferId: ride.initialOfferId,
        }),
      }));
      rideMessages[ride.id] = { success: 'Votre proposition a été envoyée au passager.' };
      await refreshRides();
    } catch (requestError) {
      const message = {
        OFFER_ALREADY_SUBMITTED: 'Vous avez déjà répondu à cette demande.',
        DRIVER_HAS_ACTIVE_RIDE: 'Terminez votre course en cours avant de proposer un autre prix.',
        RIDE_NOT_OPEN: 'Cette demande n’est plus disponible.',
        DRIVER_NOT_AVAILABLE: 'Vous devez être en ligne pour proposer un prix.',
      }[requestError.message] ?? 'Votre proposition n’a pas pu être envoyée. Réessayez.';
      rideMessages[ride.id] = { error: message };
      if (requestError.message === 'RIDE_NOT_OPEN') await refreshRides();
    } finally {
      submittingRideId = '';
    }
  }

  async function acceptPassengerPrice(ride) {
    if (acceptingRideId || submittingRideId) return;
    acceptingRideId = ride.id;
    rideMessages[ride.id] = null;
    try {
      await responseBody(await apiFetch(
        `/api/rides/${encodeURIComponent(ride.id)}/accept`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
      ));
      rides = rides.filter((item) => item.id !== ride.id);
      rideMessages[ride.id] = {
        success: 'Votre accord est envoyé. Le passager a 15 secondes pour confirmer.',
      };
      subscribeToVisibleRides();
      await refreshActiveRides();
    } catch (requestError) {
      const acceptanceErrors = {
        DRIVER_NOT_AVAILABLE: 'Vous devez être en ligne pour accepter cette demande.',
        DRIVER_HAS_ACTIVE_RIDE: 'Terminez votre course en cours avant d’accepter une autre demande.',
        OFFER_ALREADY_SUBMITTED: 'Votre accord est déjà en attente de la réponse du passager.',
        RIDE_NOT_FOUND: 'Cette demande n’existe plus.',
        RIDE_NOT_OPEN: 'Cette demande n’est plus disponible. Actualisez la liste.',
        RIDE_CATEGORY_MISMATCH: 'Cette demande ne correspond plus au véhicule actif.',
        RIDE_PRICE_UNAVAILABLE: 'Le prix proposé n’est plus disponible. Actualisez les demandes.',
      };
      rideMessages[ride.id] = {
        error: acceptanceErrors[requestError.message]
          ?? 'La demande n’a pas pu être acceptée. Vérifiez votre connexion et réessayez.',
      };
      if (['OFFER_ALREADY_SUBMITTED', 'RIDE_NOT_OPEN', 'RIDE_CATEGORY_MISMATCH']
        .includes(requestError.message)) {
        await Promise.all([refreshRides(), refreshActiveRides()]);
      }
    } finally {
      acceptingRideId = '';
    }
  }

  function updateDriverProfile(nextProfile) {
    driverProfile = nextProfile;
    rides = [];
    if (isOnline) void refreshRides();
  }

  function formatPrice(amount) {
    return `${new Intl.NumberFormat('fr-FR').format(amount)} Ar`;
  }

  function vehicleName(category) {
    return category === 'moto' ? 'Moto' : 'Voiture';
  }

  function scheduleRealtimeReconnect() {
    if ((!isOnline && !activeRides.length) || realtimeReconnectTimer) return;
    realtimeReconnectTimer = window.setTimeout(() => {
      realtimeReconnectTimer = null;
      void connectRealtime();
    }, 2_000);
  }

  async function connectRealtime() {
    if ((!isOnline && !activeRides.length) || realtimeConnecting
      || realtimeSocket?.readyState === WebSocket.OPEN) return;
    realtimeConnecting = true;
    try {
      let socket;
      if (supabaseEnabled) {
        socket = apiRealtimeConnect();
      } else {
        const ticket = await responseBody(await apiFetch('/api/realtime/ticket', {
          method: 'POST',
          headers: headers(),
        }));
        socket = apiRealtimeConnect(
          `/api/realtime?ticket=${encodeURIComponent(ticket.ticket)}`,
        );
      }
      realtimeSocket = socket;
      socket.addEventListener('open', () => {
        realtimeConnecting = false;
        subscribeToVisibleRides(socket);
        void refreshActiveRides();
      }, { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'message.created' && activeRides.some((ride) => ride.id === message.rideId)) {
          if (message.message) addActiveMessage(message.rideId, message.message);
          else void loadActiveChat(message.rideId);
        } else if (message.type === 'offers.updated') {
          void refreshActiveRides();
          void refreshRides();
        } else if (message.type === 'ride.available') {
          void refreshRides();
        } else if (message.type === 'ride.updated') {
          void refreshRides();
          void refreshActiveRides();
        }
      });
      socket.addEventListener('close', () => {
        realtimeConnecting = false;
        if (realtimeSocket === socket) realtimeSocket = null;
        scheduleRealtimeReconnect();
      }, { once: true });
      socket.addEventListener('error', () => socket.close(), { once: true });
    } catch {
      realtimeConnecting = false;
      scheduleRealtimeReconnect();
    }
  }

  function drawRideMap() {
    if (!map || !leaflet || !markerLayer) return;
    markerLayer.clearLayers();
    routeLayer?.remove();
    routeLayer = null;
    const bounds = [];
    const routes = [];

    const ridesToMap = activeRides.length ? activeRides.slice(0, 1) : rides;
    for (const ride of ridesToMap) {
      const origin = [ride.origin.latitude, ride.origin.longitude];
      const destination = [ride.destination.latitude, ride.destination.longitude];
      bounds.push(origin, destination);
      routes.push([origin, destination]);

      for (const [coordinates, kind, label] of [
        [origin, 'origin', `Départ · ${ride.origin.label}`],
        [destination, 'destination', `Destination · ${ride.destination.label}`],
      ]) {
        const content = document.createElement('span');
        content.textContent = label;
        leaflet.marker(coordinates, {
          icon: leaflet.divIcon({
            className: 'ride-map__marker',
            html: `<span class="ride-map__pin ride-map__pin--${kind}"></span>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }),
          title: label,
        }).bindPopup(leaflet.popup().setContent(content)).addTo(markerLayer);
      }
    }

    if (routes.length) {
      routeLayer = leaflet.featureGroup(routes.map((points) => leaflet.polyline(points, {
        className: 'ride-map__route',
        color: '#53aef2',
        weight: 4,
        opacity: 0.85,
        dashArray: '8 10',
      }))).addTo(map);
      map.fitBounds(leaflet.latLngBounds(bounds), { padding: [36, 36], maxZoom: 14 });
    } else if (driverSelfLocation) {
      map.setView([driverSelfLocation.latitude, driverSelfLocation.longitude], 15);
    } else {
      map.setView([-18.9137, 47.5363], 13);
    }
  }

  $effect(() => {
    if (!mapElement) return;
    let disposed = false;

    async function initializeMap() {
      try {
        const [leafletModule] = await Promise.all([
          import('leaflet'),
          import('leaflet/dist/leaflet.css'),
        ]);
        if (disposed) return;
        leaflet = leafletModule.default;
        map = leaflet.map(mapElement, {
          zoomControl: true,
          scrollWheelZoom: false,
          fadeAnimation: false,
        }).setView([-18.9137, 47.5363], 13);
        leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markerLayer = leaflet.layerGroup().addTo(map);
        userLocationLayer = leaflet.layerGroup().addTo(map);
        mapReady = true;
        drawDriverSelfLocation();
      } catch {
        if (!disposed) mapError = 'La carte ne peut pas être chargée. Vérifiez votre connexion puis réessayez.';
      }
    }

    void initializeMap();
    return () => {
      disposed = true;
      map?.remove();
      map = null;
      markerLayer = null;
      routeLayer = null;
      userLocationLayer = null;
      mapReady = false;
    };
  });

  $effect(() => {
    rides;
    activeRides;
    if (mapReady) drawRideMap();
  });

  onMount(() => {
    void loadDashboard();
    const countdownTimer = window.setInterval(() => {
      dashboardNow = Date.now();
    }, 250);
    const timer = window.setInterval(() => {
      void refreshActiveRides();
      if (isOnline) {
        void refreshRides();
      }
      void connectRealtime();
    }, 15_000);
    return () => {
      window.clearInterval(countdownTimer);
      window.clearInterval(timer);
      window.clearTimeout(realtimeReconnectTimer);
      realtimeSocket?.close();
      if (geolocationWatchId !== null) navigator.geolocation.clearWatch(geolocationWatchId);
    };
  });
</script>

<main class="driver-app">
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
      <button
        class="driver-app__profile"
        type="button"
        aria-label={`Ouvrir le compte chauffeur de ${driverProfile.name}`}
        aria-expanded={profileSettingsOpen}
        onclick={openProfileSettings}
      >
        {#if driverProfile.photoUrl}
          <img src={apiAssetUrl(driverProfile.photoUrl)} alt="" class="account-summary__photo" />
        {:else}
          <span class="account-summary__photo account-summary__photo--empty" aria-hidden="true">
            {driverProfile.name.slice(0, 1).toUpperCase()}
          </span>
        {/if}
        <span class="driver-app__profile-copy">
          <strong>{driverProfile.name}</strong>
          <span class="driver-app__profile-vehicle">Chauffeur · {vehicleName(driverProfile.vehicleCategory)}</span>
          <span class="driver-app__profile-action">Mon compte</span>
        </span>
      </button>
      <button class="auth-secondary auth-logout" type="button" onclick={onlogout}>Se déconnecter</button>
    </div>
  </header>

  {#if profileSettingsOpen}
    <section class="driver-account-page" aria-labelledby="driver-account-title">
      <button
        class="driver-account-page__back"
        type="button"
        onclick={() => {
          profileSettingsOpen = false;
        }}
      >
        <span aria-hidden="true">←</span> Retour au tableau chauffeur
      </button>
      <div class="driver-account-page__heading">
        <p class="driver-dashboard__eyebrow">Mon espace chauffeur</p>
        <h1 id="driver-account-title">Véhicules et profil</h1>
        <p>Gérez vos véhicules, vos informations personnelles et votre sécurité.</p>
      </div>
      <AccountSettings
        {token}
        profile={driverProfile}
        onprofilechange={updateDriverProfile}
      />
    </section>
  {:else}
  <section class="driver-dashboard" aria-labelledby="driver-title">
    <div class="driver-dashboard__intro">
      <div>
        <p class="driver-dashboard__eyebrow">Espace chauffeur</p>
        <h1 id="driver-title">À vous la route.</h1>
        <p class="driver-dashboard__lead">Consultez les demandes correspondant à votre véhicule et proposez votre prix.</p>
      </div>
      <button
          class="driver-availability"
          class:driver-availability--online={isOnline}
          type="button"
          aria-pressed={isOnline}
          disabled={availabilityBusy || loading}
          onclick={changeAvailability}
        >
          <span class="driver-availability__light" aria-hidden="true"></span>
          <span>
            <strong>{isOnline ? 'En ligne' : 'Hors ligne'}</strong>
            <small>{isOnline ? 'Touchez pour vous déconnecter' : 'Touchez pour recevoir des demandes'}</small>
          </span>
          <span class="driver-availability__switch" aria-hidden="true"></span>
      </button>
    </div>

    {#if error}
      <p class="driver-error" role="alert">{error}</p>
    {/if}

      <section class="driver-ride-stats" aria-label="Courses terminées">
        <div>
          <strong>{rideStats.completedToday}</strong>
          <span>Terminées aujourd’hui</span>
        </div>
        <div>
          <strong>{rideStats.completedThisWeek}</strong>
          <span>Terminées cette semaine</span>
        </div>
      </section>
      <section class="driver-requests" aria-labelledby="driver-requests-map-title">
        <div class="ride-map-panel driver-map-panel">
          <div class="ride-map-panel__heading">
            <strong id="driver-requests-map-title">{activeRides.length ? 'Votre course confirmée' : 'Demandes disponibles'}</strong>
            <span>{activeRides.length
              ? 'Course active'
              : rides.length ? `${rides.length} trajet${rides.length > 1 ? 's' : ''} affiché${rides.length > 1 ? 's' : ''}` : 'Carte des demandes'}</span>
          </div>
          <div class="ride-map__stage">
            <div
              class="ride-map driver-map"
              bind:this={mapElement}
              role="application"
              aria-label={activeRides.length
                ? 'Carte de votre course confirmée'
                : 'Carte des départs et destinations des demandes de trajet'}
            ></div>
            <button
              type="button"
              class="ride-map__locate"
              class:ride-map__locate--active={Boolean(driverSelfLocation)}
              disabled={!mapReady || locatingSelf}
              aria-label="Me localiser sur ma position actuelle"
              title="Me localiser sur ma position actuelle"
              onclick={locateOnMap}
            >
              <img src="/icons/locate.svg" alt="" aria-hidden="true" />
              <span>{locatingSelf ? 'Localisation…' : 'Me localiser'}</span>
            </button>
          </div>
          <p class="ride-map-panel__footnote">
            {#if mapError}
              {mapError}
            {:else if mapLocateMessage}
              {mapLocateMessage}
            {:else if activeRides.length}
              La carte affiche uniquement votre course confirmée la plus récente.
            {:else if !isOnline}
              Passez en ligne pour afficher les demandes disponibles sur la carte.
            {:else if rides.length}
              Les repères montrent les départs et destinations des demandes compatibles avec votre véhicule.
            {:else}
              Aucune demande disponible pour le moment.
            {/if}
          </p>
        </div>
        {#if !activeRides.length}
        <div class="driver-requests__heading">
          <div>
            <h2 id="requests-title">Demandes de trajet</h2>
            <p>{vehicleName(driverProfile.vehicleCategory)} · Les demandes compatibles arrivent dès leur publication.</p>
          </div>
          <button
            class="driver-refresh"
            type="button"
            disabled={!isOnline || loading}
            onclick={() => refreshRides()}
          >
            Actualiser
          </button>
        </div>

        {#if loading}
          <p class="driver-empty" role="status">Chargement de votre espace chauffeur…</p>
        {:else if !isOnline}
          <div class="driver-empty">
            <strong>Vous êtes hors ligne.</strong>
            <span>Passez en ligne pour voir les demandes correspondant à votre véhicule.</span>
          </div>
        {:else if rides.length === 0}
          <div class="driver-empty">
            <strong>Aucune demande pour le moment.</strong>
            <span>Restez en ligne ; les nouvelles demandes apparaîtront ici.</span>
            {#if refreshedAt}<small>Dernière vérification à {refreshedAt}</small>{/if}
          </div>
        {:else}
          <div class="driver-ride-list">
            {#each rides as ride (ride.id)}
              <article class="driver-ride">
                <div class="driver-ride__top">
                  <span class="driver-ride__category">{vehicleName(ride.category)}</span>
                  <span class="driver-ride__price">{formatPrice(ride.proposedPriceMGA)}</span>
                </div>
                {#if ride.passenger}
                  <div class="driver-ride__passenger">
                    <span>Passager : <strong>{ride.passenger.name}</strong></span>
                    {#if ride.passenger.phone}
                      <a class="ride-contact-phone" href={`tel:${ride.passenger.phone}`}>
                        <span aria-hidden="true">📞</span>
                        <span>{ride.passenger.phone}</span>
                      </a>
                    {/if}
                  </div>
                {/if}
                <div class="driver-ride__route">
                  <div class="driver-ride__route-point">
                    <span class="driver-ride__dot driver-ride__dot--origin" aria-hidden="true"></span>
                    <div><small>Départ</small><strong>{ride.origin.label}</strong></div>
                  </div>
                  <div class="driver-ride__route-point">
                    <span class="driver-ride__dot driver-ride__dot--destination" aria-hidden="true"></span>
                    <div><small>Destination</small><strong>{ride.destination.label}</strong></div>
                  </div>
                </div>
                <form class="driver-offer" onsubmit={(event) => { event.preventDefault(); void submitOffer(ride); }}>
                  <label for={`offer-${ride.id}`}>Votre proposition</label>
                  <button
                    class="driver-ride__accept"
                    type="button"
                    disabled={Boolean(acceptingRideId) || Boolean(submittingRideId)}
                    onclick={() => acceptPassengerPrice(ride)}
                  >
                    {acceptingRideId === ride.id ? 'Confirmation…' : `Accepter ${formatPrice(ride.proposedPriceMGA)}`}
                  </button>
                  <div class="driver-offer__controls">
                    <div class="driver-offer__amount">
                      <input
                        id={`offer-${ride.id}`}
                        type="number"
                        min="1"
                        step="1"
                        inputmode="numeric"
                        value={offerAmounts[ride.id] ?? ride.proposedPriceMGA}
                        oninput={(event) => { offerAmounts[ride.id] = event.currentTarget.value; }}
                        aria-label="Votre prix en ariary"
                        required
                      />
                      <span>Ar</span>
                    </div>
                    <button class="auth-submit" type="submit" disabled={submittingRideId === ride.id || acceptingRideId === ride.id}>
                      {submittingRideId === ride.id ? 'Envoi…' : 'Envoyer mon prix'}
                    </button>
                  </div>
                  {#if rideMessages[ride.id]?.success}
                    <p class="driver-feedback driver-feedback--success" role="status">{rideMessages[ride.id].success}</p>
                  {:else if rideMessages[ride.id]?.error}
                    <p class="driver-feedback driver-feedback--error" role="alert">{rideMessages[ride.id].error}</p>
                  {/if}
                </form>
              </article>
            {/each}
          </div>
          {#if refreshedAt}<p class="driver-requests__updated">Demandes mises à jour à {refreshedAt}</p>{/if}
        {/if}
        {/if}
      </section>
      {#if pendingOffers.length}
        <section class="driver-active-rides" aria-labelledby="pending-offers-title">
          <div class="driver-requests__heading">
            <div>
              <h2 id="pending-offers-title">En attente du passager</h2>
              <p>Votre accord est valable 15 secondes.</p>
            </div>
          </div>
          <div class="driver-active-rides__list">
            {#each pendingOffers as pendingOffer (pendingOffer.id)}
              <article class="driver-active-ride">
                <div class="driver-active-ride__summary">
                  <div>
                    <span class="driver-ride__category">
                      {pendingOfferSecondsRemaining(pendingOffer) > 0
                        ? `Réponse dans ${pendingOfferSecondsRemaining(pendingOffer)} s maximum`
                        : 'Délai expiré'}
                    </span>
                    <h3>{pendingOffer.ride.origin.label} → {pendingOffer.ride.destination.label}</h3>
                  </div>
                  <strong>{formatPrice(pendingOffer.amountMGA)}</strong>
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/if}
      {#if activeRides.length}
        <section class="driver-active-rides" aria-labelledby="active-rides-title">
          <div class="driver-requests__heading">
            <div>
              <h2 id="active-rides-title">Courses confirmées</h2>
              <p>Échangez avec vos passagers pendant les trajets en cours.</p>
            </div>
          </div>
          {#if rideStatusNotice}
            <p class="driver-feedback driver-feedback--success" role="status">{rideStatusNotice}</p>
          {/if}
          <div class="driver-active-rides__list">
            {#each activeRides as ride (ride.id)}
              <article class="driver-active-ride">
                <div class="driver-active-ride__summary">
                  <div>
                    <span class="driver-ride__category">
                      {ride.status === 'driver_en_route' ? 'En route vers le passager' : ride.status === 'driver_arrived' ? 'Arrivé au départ' : 'Course en cours'}
                    </span>
                    <h3>{ride.origin.label} → {ride.destination.label}</h3>
                    {#if ride.passenger}
                      <div class="driver-active-ride__passenger">
                        <span>Passager : <strong>{ride.passenger.name}</strong></span>
                        {#if ride.passenger.phone}
                          <a class="ride-contact-phone" href={`tel:${ride.passenger.phone}`}>
                            <span aria-hidden="true">📞</span>
                            <span>{ride.passenger.phone}</span>
                          </a>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  <strong>{formatPrice(ride.agreedPriceMGA)}</strong>
                </div>
                <div class="driver-active-ride__controls">
                  <button
                    class="auth-secondary"
                    type="button"
                    aria-pressed={locationSharingRideId === ride.id}
                    onclick={() => toggleLocationSharing(ride)}
                  >
                    {locationSharingRideId === ride.id ? 'Arrêter le partage GPS' : 'Partager ma position'}
                  </button>
                  {#if ride.status === 'driver_en_route'}
                    <button class="auth-submit" type="button" disabled={statusBusyRideId === ride.id} onclick={() => advanceRideStatus(ride)}>
                      {statusBusyRideId === ride.id ? 'Mise à jour…' : 'Je suis arrivé'}
                    </button>
                  {:else if ride.status === 'driver_arrived'}
                    <button class="auth-submit" type="button" disabled={statusBusyRideId === ride.id} onclick={() => advanceRideStatus(ride)}>
                      {statusBusyRideId === ride.id ? 'Mise à jour…' : 'Démarrer la course'}
                    </button>
                  {:else}
                    <button class="auth-submit" type="button" disabled={statusBusyRideId === ride.id} onclick={() => advanceRideStatus(ride)}>
                      {statusBusyRideId === ride.id ? 'Mise à jour…' : 'Terminer la course'}
                    </button>
                  {/if}
                  {#if ride.status === 'driver_en_route' || ride.status === 'driver_arrived'}
                    <button
                      class="auth-secondary driver-active-ride__cancel"
                      type="button"
                      disabled={statusBusyRideId === ride.id}
                      onclick={() => cancelActiveRide(ride)}
                    >
                      {statusBusyRideId === ride.id ? 'Annulation…' : 'Annuler la course'}
                    </button>
                  {/if}
                </div>
                {#if locationSharingRideId === ride.id}
                  <p class="driver-feedback driver-feedback--success" role="status">Partage de position activé pour cette course.</p>
                {/if}
                {#if locationErrors[ride.id]}
                  <p class="driver-feedback driver-feedback--error" role="alert">{locationErrors[ride.id]}</p>
                {/if}
                <section class="ride-chat" aria-labelledby={`driver-chat-title-${ride.id}`}>
                  <div class="ride-chat__heading">
                    <div>
                      <h3 id={`driver-chat-title-${ride.id}`}>Conversation avec le passager</h3>
                    </div>
                    <button class="driver-refresh" type="button" onclick={() => loadActiveChat(ride.id)}>Actualiser</button>
                  </div>
                  <ol class="ride-chat__messages" aria-label="Messages de la course" aria-live="polite">
                    {#each activeMessages[ride.id] ?? [] as message (message.id)}
                      <li class="ride-chat__message" class:ride-chat__message--mine={message.senderId === ride.driverId}>
                        <span>{message.sender.name}</span>
                        <p>{message.body}</p>
                        <time datetime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                        </time>
                      </li>
                    {:else}
                      <li class="ride-chat__empty">Aucun message pour le moment.</li>
                    {/each}
                  </ol>
                  {#if activeChatErrors[ride.id]}
                    <p class="ride-chat__error" role="alert">{activeChatErrors[ride.id]}</p>
                  {/if}
                  <form class="ride-chat__form" onsubmit={(event) => sendActiveMessage(ride, event)}>
                    <label class="ride-chat__label" for={`driver-chat-message-${ride.id}`}>Votre message</label>
                    <textarea
                      id={`driver-chat-message-${ride.id}`}
                      value={activeDrafts[ride.id] ?? ''}
                      oninput={(event) => { activeDrafts[ride.id] = event.currentTarget.value; }}
                      maxlength="2000"
                      rows="2"
                      placeholder="Écrivez un message…"
                      required
                    ></textarea>
                    <button class="auth-submit" type="submit" disabled={sendingChatRideId === ride.id || !(activeDrafts[ride.id] ?? '').trim()}>
                      {sendingChatRideId === ride.id ? 'Envoi…' : 'Envoyer'}
                    </button>
                  </form>
                </section>
              </article>
            {/each}
          </div>
        </section>
      {/if}
      <RideHistory {token} role="driver" />
  </section>
  {/if}
</main>
