<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import RideHistory from './RideHistory.svelte';
  import RideCompletionRating from './RideCompletionRating.svelte';
  import { apiAssetUrl, apiFetch, apiRealtimeConnect } from './lib/api.js';
  import { geolocationErrorMessage, requestCurrentPosition } from './lib/geolocation.js';
  import { fetchRoadEta, formatDistance, formatEta } from './lib/eta.js';
  import { supabaseEnabled } from './lib/supabase.js';
  import { resolveCityName } from './lib/city-detection.js';

  let { token } = $props();
  let mapElement;
  let map;
  let mapReady = $state(false);
  let leaflet;
  let routeLayer;
  let markerLayer;
  let driverLocationLayer;
  let userLocationLayer;
  let userLocation = $state(null);
  let locatingSelf = $state(false);
  let origin = $state(null);
  let destination = $state(null);
  let originQuery = $state('');
  let destinationQuery = $state('');
  let pointOnMap = $state(null);
  let places = $state({ point: null, items: [] });
  let searchBusy = $state(false);
  let searchingPoint = $state(null);
  let requestBusy = $state(false);
  let cancelBusy = $state(false);
  let searchMessage = $state('');
  let requestMessage = $state('');
  let mapMessage = $state('');
  let reverseGeocodingPoint = $state('');
  let mapLookupSequence = 0;
  let currentCity = $state('Antananarivo');
  let category = $state('moto');

  $effect(() => {
    const loc = userLocation;
    const originCoords = origin ? { latitude: origin.latitude, longitude: origin.longitude } : null;
    const target = originCoords || (loc ? { latitude: loc.latitude, longitude: loc.longitude } : null);
    if (target) {
      const detected = resolveCityName(target);
      if (detected) currentCity = detected;
    }
  });
  let proposedPrice = $state('5000');
  let publishedRide = $state(null);
  let publishedAtClientMs = $state(0);
  let offers = $state([]);
  let offersNow = $state(Date.now());
  let offersBusy = $state(false);
  let offersError = $state('');
  let acceptingOfferId = $state('');
  let rejectingOfferId = $state('');
  let offerActionMessage = $state('');
  let acceptedOffer = $state(null);
  let driverLocation = $state(null);
  let driverEta = $state(null);
  let chatMessages = $state([]);
  let chatDraft = $state('');
  let chatError = $state('');
  let chatLoading = $state(false);
  let chatSending = $state(false);
  let realtimeSocket;
  let realtimeConnecting = false;
  let realtimeReconnectTimer;

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  let distanceKm = $derived(
    origin && destination ? haversineDistance(origin, destination) : null,
  );

  onMount(() => {
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
        })
          .setView([-18.9137, 47.5363], 13);
        leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markerLayer = leaflet.layerGroup().addTo(map);
        driverLocationLayer = leaflet.layerGroup().addTo(map);
        userLocationLayer = leaflet.layerGroup().addTo(map);
        map.on('click', selectMapPoint);
        mapReady = true;
        drawRoute();
        drawUserLocation();
      } catch {
        if (!disposed) {
          mapReady = false;
          mapMessage = 'La carte ne peut pas être chargée. Vous pouvez toujours rechercher une adresse.';
        }
      }
    }

    void initializeMap();
    return () => {
      disposed = true;
      map?.remove();
      map = null;
    };
  });

  function haversineDistance(from, to) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = radians(to.latitude - from.latitude);
    const longitudeDelta = radians(to.longitude - from.longitude);
    const arc = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(radians(from.latitude))
      * Math.cos(radians(to.latitude))
      * Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
  }

  function updatePoint(point, place) {
    if (point === 'origin') {
      origin = place;
      originQuery = place.label;
    } else {
      destination = place;
      destinationQuery = place.label;
    }
    places = { point: null, items: [] };
    requestMessage = '';
    publishedRide = null;
    drawRoute();
  }

  function selectMapPoint(event) {
    if (!pointOnMap) return;
    const point = pointOnMap;
    const { lat, lng } = event.latlng;
    updatePoint(point, { label: '', latitude: lat, longitude: lng, source: 'map' });
    reverseGeocodingPoint = point;
    pointOnMap = null;
    const lookupSequence = ++mapLookupSequence;
    mapMessage = 'Recherche du nom du lieu…';
    void resolveMapPointName(point, lat, lng, lookupSequence);
  }

  async function locateOnMap() {
    if (!mapReady || locatingSelf) return;
    locatingSelf = true;
    mapMessage = 'Localisation de votre position en cours…';
    try {
      const coords = await requestCurrentPosition();
      userLocation = coords;
      drawUserLocation();
      const targetPoint = pointOnMap ?? (!publishedRide && !origin ? 'origin' : null);
      if (targetPoint) {
        updatePoint(targetPoint, {
          label: 'Ma position actuelle',
          latitude: coords.latitude,
          longitude: coords.longitude,
          source: 'map',
        });
        reverseGeocodingPoint = targetPoint;
        pointOnMap = null;
        const lookupSequence = ++mapLookupSequence;
        void resolveMapPointName(targetPoint, coords.latitude, coords.longitude, lookupSequence);
      }
      map?.setView([coords.latitude, coords.longitude], 16);
      mapMessage = targetPoint
        ? 'Position actuelle détectée et appliquée sur votre trajet.'
        : 'Carte centrée sur votre position actuelle.';
    } catch (error) {
      mapMessage = geolocationErrorMessage(error);
    } finally {
      locatingSelf = false;
    }
  }

  async function resolveMapPointName(point, latitude, longitude, lookupSequence) {
    try {
      const response = await apiFetch(
        `/api/places/reverse?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'PLACE_NAME_NOT_FOUND');
      if (lookupSequence !== mapLookupSequence) return;
      const selected = point === 'origin' ? origin : destination;
      if (selected?.latitude !== latitude || selected?.longitude !== longitude) return;
      const place = { ...selected, label: body.label };
      if (point === 'origin') {
        origin = place;
        originQuery = place.label;
        if (body.label) {
          const detected = resolveCityName({ latitude, longitude, nominatimData: { display_name: body.label } });
          if (detected) currentCity = detected;
        }
      } else {
        destination = place;
        destinationQuery = place.label;
      }
      mapMessage = '';
      drawRoute();
    } catch (error) {
      if (lookupSequence !== mapLookupSequence) return;
      const selected = point === 'origin' ? origin : destination;
      if (selected?.label?.trim()) {
        mapMessage = '';
      } else {
        mapMessage = error.message === 'PLACE_NAME_NOT_FOUND'
          ? 'Nom du lieu introuvable. Saisissez-le dans le champ pour continuer.'
          : 'Le nom du lieu n’a pas pu être trouvé. Vous pouvez le saisir vous-même.';
      }
    } finally {
      if (lookupSequence === mapLookupSequence) reverseGeocodingPoint = '';
    }
  }

  function renameMapPoint(point, label) {
    const selected = point === 'origin' ? origin : destination;
    if (!selected || selected.source !== 'map') return;
    const updated = { ...selected, label };
    if (point === 'origin') {
      origin = updated;
    } else {
      destination = updated;
    }
    requestMessage = '';
  }

  function canPublishRoute() {
    return Boolean(
      origin?.label.trim().length >= 2
      && destination?.label.trim().length >= 2
      && !reverseGeocodingPoint,
    );
  }

  function handleQueryInput(point, value) {
    if (point === 'origin' && origin && value !== origin.label) origin = null;
    if (point === 'destination' && destination && value !== destination.label) destination = null;
    places = { point: null, items: [] };
    publishedRide = null;
    drawRoute();
  }

  function drawRoute() {
    if (!map || !leaflet) return;
    markerLayer?.clearLayers();
    routeLayer?.remove();
    const points = [];

    for (const [point, location, color] of [
      ['origin', origin, 'origin'],
      ['destination', destination, 'destination'],
    ]) {
      if (!location) continue;
      const coordinates = [location.latitude, location.longitude];
      points.push(coordinates);
      leaflet.marker(coordinates, {
        icon: leaflet.divIcon({
          className: 'ride-map__marker',
          html: `<span class="ride-map__pin ride-map__pin--${color}"></span>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        title: point === 'origin' ? 'Départ' : 'Destination',
      }).addTo(markerLayer);
    }

    if (points.length === 2) {
      routeLayer = leaflet.polyline(points, {
        className: 'ride-map__route',
        color: '#53aef2',
        weight: 4,
        opacity: 0.9,
        dashArray: '8 10',
      }).addTo(map);
      map.fitBounds(leaflet.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
    } else if (points.length === 1) {
      map.setView(points[0], 15);
    }
  }

  function drawDriverLocation() {
    if (!map || !leaflet || !driverLocationLayer) return;
    driverLocationLayer.clearLayers();
    if (!driverLocation) return;
    leaflet.marker([driverLocation.latitude, driverLocation.longitude], {
      icon: leaflet.divIcon({
        className: 'ride-map__marker',
        html: '<span class="ride-map__pin ride-map__pin--driver"></span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      title: 'Position actuelle du chauffeur',
    }).addTo(driverLocationLayer);
  }

  function drawUserLocation() {
    if (!map || !leaflet || !userLocationLayer) return;
    userLocationLayer.clearLayers();
    if (!userLocation) return;
    leaflet.marker([userLocation.latitude, userLocation.longitude], {
      icon: leaflet.divIcon({
        className: 'ride-map__marker',
        html: '<span class="ride-map__pin ride-map__pin--self"></span>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      title: 'Ma position actuelle',
    }).addTo(userLocationLayer);
  }

  function rideStatusLabel(status) {
    return {
      driver_en_route: 'Le chauffeur est en route vers vous',
      driver_arrived: 'Le chauffeur est arrivé au départ',
      in_progress: 'Votre trajet est en cours',
      completed: 'Trajet terminé',
      cancelled: 'Trajet annulé',
    }[status] ?? 'Trajet confirmé';
  }

  function canCancelPublishedRide() {
    return ['searching', 'negotiating', 'driver_en_route', 'driver_arrived']
      .includes(publishedRide?.status);
  }

  async function cancelPublishedRide() {
    if (!publishedRide || cancelBusy || !canCancelPublishedRide()) return;
    if (!window.confirm('Annuler cette course ? Le chauffeur en sera informé.')) return;
    cancelBusy = true;
    requestMessage = '';
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(publishedRide.id)}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RIDE_CANCELLATION_FAILED');
      publishedRide = body.ride;
      offers = offers.map((offer) => offer.status === 'pending'
        ? { ...offer, status: 'withdrawn' }
        : offer);
      driverLocation = null;
      drawDriverLocation();
      chatMessages = [];
      chatDraft = '';
      chatError = '';
      offerActionMessage = 'La course est annulée. Le chauffeur a été informé.';
    } catch (cancelError) {
      requestMessage = cancelError.message === 'RIDE_CANNOT_BE_CANCELLED'
        ? 'Cette course ne peut plus être annulée depuis l’application.'
        : cancelError.message === 'RIDE_NOT_FOUND'
          ? 'Cette course n’existe plus.'
          : 'La course n’a pas pu être annulée. Actualisez son état puis réessayez.';
    } finally {
      cancelBusy = false;
    }
  }

  async function searchPlaces(point) {
    const query = point === 'origin' ? originQuery.trim() : destinationQuery.trim();
    if (query.length < 3) {
      searchMessage = 'Saisissez au moins 3 caractères pour rechercher une adresse.';
      places = { point: null, items: [] };
      return;
    }

    searchBusy = true;
    searchingPoint = point;
    searchMessage = '';
    places = { point: null, items: [] };
    try {
      const response = await apiFetch(`/api/places/search?q=${encodeURIComponent(query)}`, {
        headers: { authorization: 'Bearer ' + token },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'PLACE_SEARCH_UNAVAILABLE');
      places = { point, items: body.places };
      searchMessage = body.places.length
        ? ''
        : 'Aucune adresse trouvée autour d’Antananarivo. Essayez un quartier voisin.';
    } catch (error) {
      searchMessage = error.message === 'PLACE_SEARCH_UNAVAILABLE'
        ? 'La recherche d’adresse est temporairement indisponible. Vous pouvez choisir un point sur la carte.'
        : 'Impossible de rechercher cette adresse. Vérifiez votre connexion et réessayez.';
    } finally {
      searchBusy = false;
      searchingPoint = null;
    }
  }

  function startAnotherRide() {
    realtimeSocket?.close();
    realtimeSocket = null;
    window.clearTimeout(realtimeReconnectTimer);
    origin = null;
    destination = null;
    originQuery = '';
    destinationQuery = '';
    pointOnMap = null;
    places = { point: null, items: [] };
    requestMessage = '';
    searchMessage = '';
    publishedRide = null;
    offers = [];
    offersError = '';
    acceptedOffer = null;
    chatMessages = [];
    chatDraft = '';
    chatError = '';
    offerActionMessage = '';
    proposedPrice = '5000';
    map?.setView(
      userLocation ? [userLocation.latitude, userLocation.longitude] : [-18.9137, 47.5363],
      userLocation ? 15 : 13,
    );
    drawRoute();
  }

  async function submitRide(event) {
    event.preventDefault();
    requestBusy = true;
    requestMessage = '';
    offerActionMessage = '';
    publishedRide = null;
    offers = [];
    offersError = '';
    acceptedOffer = null;
    chatMessages = [];
    chatError = '';

    try {
      const response = await apiFetch('/api/rides', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          origin,
          destination,
          category,
          proposedPriceMGA: Number(proposedPrice),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RIDE_REQUEST_FAILED');
      publishedRide = body.ride;
      publishedAtClientMs = Date.now();
      void loadOffers(body.ride.id);
      void connectRealtime();
    } catch (error) {
      requestMessage = error.message === 'ROUTE_POINTS_MUST_DIFFER'
        ? 'Choisissez deux points différents pour votre trajet.'
        : error.message === 'PLACE_LABEL_REQUIRED'
          ? 'Ajoutez un nom au départ et à la destination.'
          : 'La demande n’a pas pu être publiée. Vérifiez votre connexion et réessayez.';
    } finally {
      requestBusy = false;
    }
  }

  async function loadOffers(rideId = publishedRide?.id) {
    if (!rideId || acceptedOffer || offersBusy) return;
    offersBusy = true;
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(rideId)}/offers`, {
        headers: { authorization: 'Bearer ' + token },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'OFFERS_UNAVAILABLE');
      offers = body.offers
        .map((offer) => offer.acceptedBy
          ? { ...offer, proposer: offer.acceptedBy }
          : offer)
        .filter((offer) => offer.proposer.vehicleCategory);
      offersError = '';
      if (body.ride?.status && publishedRide && publishedRide.status !== body.ride.status) {
        publishedRide = { ...publishedRide, status: body.ride.status };
        if (body.ride.status === 'completed') {
          driverLocation = null;
          driverEta = null;
          driverLocationLayer?.clearLayers();
        }
      }
      const selectedOffer = offers.find((offer) => offer.status === 'accepted');
      if (selectedOffer) {
        acceptedOffer = selectedOffer;
        void loadChat(rideId);
        void loadDriverLocation(rideId);
        void connectRealtime();
      }
    } catch {
      offersError = 'Les offres ne peuvent pas être actualisées. Vérifiez votre connexion puis réessayez.';
    } finally {
      offersBusy = false;
    }
  }

  async function loadRideStatus(rideId = publishedRide?.id) {
    if (!rideId || publishedRide?.status === 'completed') return;
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(rideId)}/offers`, {
        headers: { authorization: 'Bearer ' + token },
      });
      if (!response.ok) return;
      const body = await response.json();
      if (body?.ride?.status && publishedRide && publishedRide.status !== body.ride.status) {
        publishedRide = { ...publishedRide, status: body.ride.status };
        if (body.ride.status === 'completed') {
          driverLocation = null;
          driverEta = null;
          driverLocationLayer?.clearLayers();
        }
      }
    } catch {
      // Ignoré en cas d'indisponibilité réseau
    }
  }

  function dismissCompletedRide() {
    publishedRide = null;
    acceptedOffer = null;
    offers = [];
    chatMessages = [];
    chatDraft = '';
    driverLocation = null;
    driverEta = null;
    publishedAtClientMs = 0;
    offerActionMessage = '';
    origin = null;
    destination = null;
    originQuery = '';
    destinationQuery = '';
    drawRoute();
  }

  async function acceptOffer(offer) {
    if (!publishedRide || acceptingOfferId || acceptedOffer) return;
    if (offerSecondsRemaining(offer) === 0) {
      offerActionMessage = 'Le délai de confirmation est terminé. La recherche reprend.';
      void loadOffers(publishedRide.id);
      return;
    }
    acceptingOfferId = offer.id;
    offersError = '';
    offerActionMessage = '';
    try {
      const response = await apiFetch(
        `/api/rides/${encodeURIComponent(publishedRide.id)}/offers/${encodeURIComponent(offer.id)}/accept`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'OFFER_ACCEPTANCE_FAILED');
      publishedRide = body.ride;
      acceptedOffer = { ...offer, status: 'accepted' };
      driverLocation = null;
      driverEta = null;
      drawDriverLocation();
      void loadChat(publishedRide.id);
      void loadDriverLocation(publishedRide.id);
      void connectRealtime();
      offers = offers.map((item) => ({
        ...item,
        status: item.id === offer.id ? 'accepted' : 'rejected',
      }));
    } catch (error) {
      offersError = error.message === 'DRIVER_NOT_AVAILABLE'
        ? 'Ce chauffeur n’est plus disponible. Actualisez les offres et choisissez-en une autre.'
        : error.message === 'RIDE_NOT_OPEN' || error.message === 'OFFER_NOT_ACCEPTABLE'
          ? 'Cette offre n’est plus disponible. Actualisez la liste pour voir les offres à jour.'
          : 'Cette offre n’a pas pu être acceptée. Réessayez.';
      void loadOffers(publishedRide.id);
    } finally {
      acceptingOfferId = '';
    }
  }

  async function rejectOffer(offer) {
    if (!publishedRide || acceptingOfferId || rejectingOfferId || acceptedOffer) return;
    if (offerSecondsRemaining(offer) === 0) {
      offerActionMessage = 'Le délai de confirmation est terminé. La recherche reprend.';
      void loadOffers(publishedRide.id);
      return;
    }
    rejectingOfferId = offer.id;
    offersError = '';
    offerActionMessage = '';
    try {
      const response = await apiFetch(
        `/api/rides/${encodeURIComponent(publishedRide.id)}/offers/${encodeURIComponent(offer.id)}/reject`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'OFFER_REJECTION_FAILED');
      offers = offers.map((item) => item.id === offer.id
        ? { ...item, status: 'rejected' }
        : item);
      offerActionMessage = 'Offre refusée. La recherche continue.';
    } catch (error) {
      offersError = error.message === 'RIDE_NOT_OPEN' || error.message === 'OFFER_NOT_REJECTABLE'
        ? 'Cette offre n’est plus disponible. Actualisez la liste pour voir les offres à jour.'
        : 'Cette offre n’a pas pu être refusée. Réessayez.';
      void loadOffers(publishedRide.id);
    } finally {
      rejectingOfferId = '';
    }
  }

  function addChatMessage(message) {
    if (chatMessages.some((item) => item.id === message.id)) return;
    chatMessages = [...chatMessages, message];
  }

  async function loadChat(rideId = publishedRide?.id) {
    if (!rideId || !acceptedOffer || chatLoading) return;
    chatLoading = true;
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(rideId)}/messages`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'CHAT_UNAVAILABLE');
      chatMessages = body.messages;
      chatError = '';
    } catch {
      chatError = 'La conversation ne peut pas être actualisée. Vérifiez votre connexion puis réessayez.';
    } finally {
      chatLoading = false;
    }
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!publishedRide || !body || chatSending) return;
    chatSending = true;
    chatError = '';
    try {
      const response = await apiFetch(
        `/api/rides/${encodeURIComponent(publishedRide.id)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ body }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'CHAT_SEND_FAILED');
      addChatMessage(result.message);
      chatDraft = '';
    } catch (error) {
      chatError = error.message === 'RIDE_CHAT_NOT_ACTIVE'
        ? 'La course est terminée ; vous ne pouvez plus envoyer de message.'
        : 'Votre message n’a pas pu être envoyé. Vérifiez votre connexion puis réessayez.';
    } finally {
      chatSending = false;
    }
  }

  async function refreshDriverEta() {
    if (!driverLocation || !origin || !publishedRide) {
      driverEta = null;
      return;
    }
    try {
      const eta = await fetchRoadEta(driverLocation, origin, {
        category: publishedRide.category,
      });
      driverEta = eta;
    } catch {
      driverEta = null;
    }
  }

  async function loadDriverLocation(rideId = publishedRide?.id) {
    if (!rideId || !acceptedOffer) return;
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(rideId)}/location`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const body = await response.json();
      if (body?.location) {
        driverLocation = body.location;
        drawDriverLocation();
        void refreshDriverEta();
      }
    } catch {
      // Ignoré en cas de déconnexion temporaire
    }
  }

  function offerVehicle(offer) {
    const details = [
      offer.proposer.vehicleMake,
      offer.proposer.vehicleModel,
      offer.proposer.vehicleColor,
      offer.proposer.vehicleRegistration,
    ].filter(Boolean);
    return `${vehicleName(offer.proposer.vehicleCategory)}${details.length ? ` · ${details.join(' · ')}` : ''}`;
  }

  function vehicleName(vehicleCategory) {
    return vehicleCategory === 'moto' ? 'Moto' : 'Voiture';
  }

  function offerSecondsRemaining(offer) {
    if (!offer.expiresAt) return null;
    return Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - offersNow) / 1000));
  }

  function offerRemainingProgress(offer) {
    if (!offer.expiresAt) return null;
    const createdAt = Date.parse(offer.createdAt);
    const expiresAt = Date.parse(offer.expiresAt);
    const duration = expiresAt - createdAt;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || duration <= 0) return 0;
    return Math.max(0, Math.min(100, ((expiresAt - offersNow) / duration) * 100));
  }

  function scheduleRealtimeReconnect() {
    if (!publishedRide || realtimeReconnectTimer) return;
    realtimeReconnectTimer = window.setTimeout(() => {
      realtimeReconnectTimer = null;
      void connectRealtime();
    }, 2_000);
  }

  async function connectRealtime() {
    if (!publishedRide || realtimeConnecting
      || realtimeSocket?.readyState === WebSocket.OPEN) return;
    realtimeConnecting = true;
    try {
      let socket;
      if (supabaseEnabled) {
        socket = apiRealtimeConnect();
      } else {
        const ticketResponse = await apiFetch('/api/realtime/ticket', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
        });
        const ticketBody = await ticketResponse.json();
        if (!ticketResponse.ok) throw new Error(ticketBody.error ?? 'REALTIME_TICKET_FAILED');
        socket = apiRealtimeConnect(
          `/api/realtime?ticket=${encodeURIComponent(ticketBody.ticket)}`,
        );
      }
      realtimeSocket = socket;
      socket.addEventListener('open', () => {
        realtimeConnecting = false;
        if (publishedRide) {
          socket.send(JSON.stringify({ type: 'subscribe', rideId: publishedRide.id }));
          if (acceptedOffer) void loadChat(publishedRide.id);
        }
      }, { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.rideId !== publishedRide?.id) return;
        if (message.type === 'message.created' && acceptedOffer) {
          if (message.message) addChatMessage(message.message);
          else void loadChat(message.rideId);
        } else if (message.type === 'ride.location.updated' && acceptedOffer) {
          driverLocation = message.location;
          drawDriverLocation();
          void refreshDriverEta();
        } else if (message.type === 'ride.updated') {
          publishedRide = { ...publishedRide, status: message.status };
          if (message.status === 'completed') {
            driverLocation = null;
            driverEta = null;
            driverLocationLayer?.clearLayers();
          } else if (acceptedOffer) {
            void loadDriverLocation();
          } else {
            void loadOffers(message.rideId);
          }
        } else if (!acceptedOffer
          && message.type === 'offers.updated') {
          void loadOffers(message.rideId);
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

  onMount(() => {
    const countdownTimer = window.setInterval(() => {
      offersNow = Date.now();
    }, 250);
    const timer = window.setInterval(() => {
      if (publishedRide) {
        if (publishedRide.status === 'completed') {
          return;
        }
        if (publishedRide.status === 'cancelled') {
          publishedRide = null;
          offers = [];
          publishedAtClientMs = 0;
          offerActionMessage = 'Votre demande a été annulée ou a expiré après 30 minutes.';
          return;
        }
        if (publishedRide.status === 'searching') {
          const hasOffers = offers.some((o) => o.status === 'pending' || o.status === 'accepted');
          if (!hasOffers && publishedAtClientMs > 0 && Date.now() - publishedAtClientMs >= 30 * 60 * 1000) {
            void cancelRide();
            publishedRide = null;
            offers = [];
            publishedAtClientMs = 0;
            offerActionMessage = 'Votre demande a expiré après 30 minutes sans proposition de chauffeur.';
            return;
          }
        }
        if (acceptedOffer) {
          void loadChat();
          void loadDriverLocation();
          void loadRideStatus();
        } else {
          void loadOffers();
        }
        void connectRealtime();
      }
    }, 5_000);
    return () => {
      window.clearInterval(countdownTimer);
      window.clearInterval(timer);
      window.clearTimeout(realtimeReconnectTimer);
      realtimeSocket?.close();
    };
  });
</script>

<section class="passenger-request" aria-labelledby="passenger-request-title">
  <header class="passenger-request__heading">
    <div>
      <p class="passenger-request__location">{currentCity}</p>
      <h1 id="passenger-request-title">Où allez-vous ?</h1>
      <p class="passenger-request__intro">Choisissez votre trajet et le prix que vous souhaitez proposer.</p>
    </div>
    {#if distanceKm !== null}
      <p class="passenger-request__distance" transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>
        <strong>{distanceKm.toFixed(1)} km</strong>
        <span>à vol d’oiseau</span>
      </p>
    {/if}
  </header>

  <div class="passenger-request__layout">
    <form class="ride-form" onsubmit={submitRide}>
      <fieldset class="ride-form__route">
        <legend>Votre trajet</legend>
        <div class="ride-form__point ride-form__point--origin">
          <label for="ride-origin">Départ</label>
          <div class="ride-form__search">
            <input
              id="ride-origin"
              bind:value={originQuery}
              autocomplete="off"
              placeholder="Ex. Analakely"
              oninput={(event) => handleQueryInput('origin', event.currentTarget.value)}
            />
            <button type="button" class="ride-form__search-button" disabled={searchBusy} onclick={() => searchPlaces('origin')}>
              {searchBusy && searchingPoint === 'origin' ? 'Recherche…' : 'Chercher'}
            </button>
          </div>
          {#if origin}
            {#if origin.source === 'map'}
              <label class="ride-form__selected-label" for="ride-origin-map-label">
                Nom du lieu choisi sur la carte
                <input
                  id="ride-origin-map-label"
                  class="ride-form__selected ride-form__selected--editable"
                  value={origin.label}
                  maxlength="200"
                  placeholder="Ex. Gare de Soarano"
                  oninput={(event) => renameMapPoint('origin', event.currentTarget.value)}
                  required
                />
              </label>
            {:else}
              <p class="ride-form__selected" title={origin.label} transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>{origin.label}</p>
            {/if}
          {/if}
          <button
            type="button"
            class:ride-form__map-choice--active={pointOnMap === 'origin'}
            class="ride-form__map-choice"
            disabled={!mapReady}
            aria-label="Choisir le départ sur la carte"
            title="Choisir le départ sur la carte"
            onclick={() => { pointOnMap = 'origin'; }}
          >
            <img src="/icons/map.svg" alt="" aria-hidden="true" />
          </button>
        </div>

        <div class="ride-form__point ride-form__point--destination">
          <label for="ride-destination">Destination</label>
          <div class="ride-form__search">
            <input
              id="ride-destination"
              bind:value={destinationQuery}
              autocomplete="off"
              placeholder="Ex. Ivandry"
              oninput={(event) => handleQueryInput('destination', event.currentTarget.value)}
            />
            <button type="button" class="ride-form__search-button" disabled={searchBusy} onclick={() => searchPlaces('destination')}>
              {searchBusy && searchingPoint === 'destination' ? 'Recherche…' : 'Chercher'}
            </button>
          </div>
          {#if destination}
            {#if destination.source === 'map'}
              <label class="ride-form__selected-label" for="ride-destination-map-label">
                Nom du lieu choisi sur la carte
                <input
                  id="ride-destination-map-label"
                  class="ride-form__selected ride-form__selected--editable"
                  value={destination.label}
                  maxlength="200"
                  placeholder="Ex. Université d’Ankatso"
                  oninput={(event) => renameMapPoint('destination', event.currentTarget.value)}
                  required
                />
              </label>
            {:else}
              <p class="ride-form__selected" title={destination.label} transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>{destination.label}</p>
            {/if}
          {/if}
          <button
            type="button"
            class:ride-form__map-choice--active={pointOnMap === 'destination'}
            class="ride-form__map-choice"
            disabled={!mapReady}
            aria-label="Choisir la destination sur la carte"
            title="Choisir la destination sur la carte"
            onclick={() => { pointOnMap = 'destination'; }}
          >
            <img src="/icons/map.svg" alt="" aria-hidden="true" />
          </button>
        </div>
      </fieldset>

      {#if places.items.length}
        <div
          class="ride-form__places"
          aria-label="Résultats de recherche"
          transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}
        >
          {#each places.items as place (place.id)}
            <button type="button" class="ride-form__place" onclick={() => updatePoint(places.point, place)}>
              <span>{place.label}</span>
              <small>Utiliser cette adresse</small>
            </button>
          {/each}
        </div>
      {/if}
      {#if searchMessage}
        <p class="ride-form__message" role="status" transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>{searchMessage}</p>
      {/if}

      <fieldset class="ride-form__category">
        <legend>Catégorie de véhicule</legend>
        <div class="ride-form__category-options">
          <label class:ride-form__category-option--selected={category === 'moto'} class="ride-form__category-option">
            <input type="radio" name="ride-category" value="moto" bind:group={category} />
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" />
              <path d="m6 17 4-7h4l4 7m-8-7-2-3H5m7 3 2 4h4m-7-4h4" />
            </svg>
            <span>Moto</span>
          </label>
          <label class:ride-form__category-option--selected={category === 'voiture'} class="ride-form__category-option">
            <input type="radio" name="ride-category" value="voiture" bind:group={category} />
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m4 12 1.7-5.1A2 2 0 0 1 7.6 5.5h8.8a2 2 0 0 1 1.9 1.4L20 12v6h-2v-2H6v2H4v-6Z" />
              <path d="M4 12h16M7 12l1-3h8l1 3" /><circle cx="7.5" cy="14" r=".75" /><circle cx="16.5" cy="14" r=".75" />
            </svg>
            <span>Voiture</span>
          </label>
        </div>
      </fieldset>

      <label class="ride-form__field">
        Votre prix (Ar)
        <input
          bind:value={proposedPrice}
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          required
        />
      </label>
      {#if pointOnMap}
        <p
          class="ride-form__message"
          role="status"
          transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}
        >
          Touchez la carte pour placer le point de {pointOnMap === 'origin' ? 'départ' : 'destination'}.
        </p>
      {/if}
      {#if mapMessage}
        <p class="ride-form__message" role="status" transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>{mapMessage}</p>
      {/if}
      {#if requestMessage}
        <p class="ride-form__message ride-form__message--error" role="alert" transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>{requestMessage}</p>
      {/if}
      {#if publishedRide}
        <div
          class="ride-form__success"
          role="status"
          transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}
        >
          <strong>{publishedRide.status === 'cancelled' ? 'Votre course est annulée.' : 'Votre demande est publiée.'}</strong>
          <span>{publishedRide.status === 'cancelled'
            ? 'La recherche est arrêtée et le chauffeur a été informé.'
            : `Prix proposé : ${publishedRide.proposedPriceMGA.toLocaleString('fr-FR')} Ar. Les propositions des chauffeurs apparaîtront ci-dessous.`}</span>
        </div>
      {/if}

      {#if publishedRide}
        <div class="ride-form__published-actions">
          {#if canCancelPublishedRide()}
            <button
              class="auth-secondary"
              type="button"
              disabled={cancelBusy}
              onclick={cancelPublishedRide}
            >
              {cancelBusy ? 'Annulation…' : 'Annuler ma course'}
            </button>
          {/if}
          <button class="auth-secondary ride-form__submit" type="button" onclick={startAnotherRide}>Créer une nouvelle demande</button>
        </div>
      {:else}
        <button class="auth-submit ride-form__submit" type="submit" disabled={requestBusy || !canPublishRoute()}>
          {requestBusy ? 'Publication…' : 'Publier ma demande'}
        </button>
      {/if}
    </form>

    <div class="ride-map-panel">
      <div class="ride-map-panel__heading">
        <strong>Votre itinéraire</strong>
        <span>{pointOnMap ? 'Choisissez un point sur la carte' : 'Carte d’Antananarivo'}</span>
      </div>
      <div class="ride-map__stage">
        <div class="ride-map" bind:this={mapElement} role="application" aria-label="Carte interactive pour choisir le départ et la destination"></div>
        <button
          type="button"
          class="ride-map__locate"
          class:ride-map__locate--active={Boolean(userLocation)}
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
        {#if acceptedOffer && publishedRide.status}
          <span>{rideStatusLabel(publishedRide.status)}{#if driverLocation} · Position actualisée à {new Date(driverLocation.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}{/if}</span>
        {:else if origin && destination}
          <span transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>Départ et destination sélectionnés</span>
        {:else}
          <span transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>Recherchez une adresse, touchez « Me localiser » ou sélectionnez un point sur la carte</span>
        {/if}
      </p>
    </div>
  </div>

  {#if publishedRide}
    {#if publishedRide.status === 'completed'}
      <RideCompletionRating
        {token}
        role="passenger"
        ride={{
          id: publishedRide.id,
          origin: origin ?? publishedRide.origin,
          destination: destination ?? publishedRide.destination,
          agreedPriceMGA: acceptedOffer?.amountMGA ?? publishedRide.agreedPriceMGA,
          counterparty: acceptedOffer?.proposer ?? null,
        }}
        onClose={dismissCompletedRide}
      />
    {:else}
      <section class="passenger-offers" aria-labelledby="passenger-offers-title">
        <header class="passenger-offers__heading">
        <div>
          <h2 id="passenger-offers-title">{acceptedOffer ? 'Trajet confirmé' : 'Propositions des chauffeurs'}</h2>
          {#if publishedRide.status === 'cancelled'}
            <div class="passenger-offers__empty" role="status">
              <strong>Course annulée</strong>
              <span>Vous pouvez créer une nouvelle demande quand vous le souhaitez.</span>
            </div>
          {:else if acceptedOffer}
            <p>
              Vous avez choisi une offre. Le prix convenu sera réglé directement au chauffeur.
            </p>
          {:else}
            <p>
              Choisissez l’offre qui vous convient ; aucun paiement ne passe par DriveNight.
            </p>
          {/if}
        </div>
        {#if !acceptedOffer}
          <button
            class="driver-refresh"
            type="button"
            disabled={offersBusy}
            onclick={() => loadOffers()}
          >
            {offersBusy ? 'Actualisation…' : 'Actualiser'}
          </button>
        {/if}
      </header>

      {#if acceptedOffer}
        <article class="passenger-offer passenger-offer--accepted" role="status">
          <div class="passenger-offer__identity">
            {#if acceptedOffer.proposer.photoUrl}
              <img src={apiAssetUrl(acceptedOffer.proposer.photoUrl)} alt="" class="passenger-offer__photo" />
            {:else}
              <span class="passenger-offer__photo passenger-offer__photo--empty" aria-hidden="true">
                {acceptedOffer.proposer.name.slice(0, 1).toUpperCase()}
              </span>
            {/if}
            <div>
              <strong>{acceptedOffer.proposer.name}</strong>
              <span>{offerVehicle(acceptedOffer)}</span>
              {#if acceptedOffer.proposer.phone}
                <a class="ride-contact-phone ride-contact-phone--call" href={`tel:${acceptedOffer.proposer.phone}`}>
                  <span aria-hidden="true">📞</span>
                  <span>Appeler {acceptedOffer.proposer.phone}</span>
                </a>
              {/if}
            </div>
          </div>
          <div class="passenger-offer__decision">
            <span>{rideStatusLabel(publishedRide.status)}</span>
            <span>Prix convenu</span>
            <strong>{acceptedOffer.amountMGA.toLocaleString('fr-FR')} Ar</strong>
            <small>Règlement direct au chauffeur, hors application</small>
          </div>
        </article>

        {#if publishedRide.status === 'driver_arrived'}
          <div class="ride-eta-banner ride-eta-banner--arrived" role="status">
            <span class="ride-eta-banner__icon" aria-hidden="true">📍</span>
            <div>
              <strong>Le chauffeur est arrivé sur place !</strong>
              <small>Retrouvez votre chauffeur au point de départ convenu.</small>
            </div>
          </div>
        {:else if publishedRide.status === 'in_progress'}
          <div class="ride-eta-banner ride-eta-banner--en-route" role="status">
            <span class="ride-eta-banner__icon" aria-hidden="true">🚗</span>
            <div>
              <strong>Course en cours</strong>
              <small>Trajet en direction de votre destination.</small>
            </div>
          </div>
        {:else if driverEta}
          <div class="ride-eta-banner" role="status">
            <span class="ride-eta-banner__pulse" aria-hidden="true"></span>
            <div>
              <strong>Arrivée estimée dans ~{formatEta(driverEta.minutes)}</strong>
              <small>Chauffeur à {formatDistance(driverEta.distanceKm)} de votre départ (suivi en direct)</small>
            </div>
          </div>
        {:else if driverLocation}
          <div class="ride-eta-banner" role="status">
            <span class="ride-eta-banner__pulse" aria-hidden="true"></span>
            <div>
              <strong>Chauffeur en route vers vous</strong>
              <small>Position suivie en direct sur la carte</small>
            </div>
          </div>
        {:else}
          <div class="ride-eta-banner ride-eta-banner--waiting" role="status">
            <span class="ride-eta-banner__pulse" aria-hidden="true"></span>
            <div>
              <strong>Chauffeur confirmé · En route vers vous</strong>
              <small>L’estimation d’arrivée s’affichera dès transmission du signal GPS</small>
            </div>
          </div>
        {/if}
        <section class="ride-chat" aria-labelledby="passenger-chat-title">
          <div class="ride-chat__heading">
            <div>
              <h3 id="passenger-chat-title">Conversation avec {acceptedOffer.proposer.name}</h3>
              <p>Échangez les informations utiles pour votre trajet.</p>
            </div>
            <button class="driver-refresh" type="button" disabled={chatLoading} onclick={() => loadChat()}>
              {chatLoading ? 'Actualisation…' : 'Actualiser'}
            </button>
          </div>
          <ol class="ride-chat__messages" aria-label="Messages de la course" aria-live="polite">
            {#each chatMessages as message (message.id)}
              <li class="ride-chat__message" class:ride-chat__message--mine={message.senderId === publishedRide.passengerId}>
                <span>{message.sender.name}</span>
                <p>{message.body}</p>
                <time datetime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </time>
              </li>
            {:else}
              <li class="ride-chat__empty">{chatLoading ? 'Chargement de la conversation…' : 'Aucun message pour le moment.'}</li>
            {/each}
          </ol>
          {#if chatError}
            <p class="ride-chat__error" role="alert">{chatError}</p>
          {/if}
          <form class="ride-chat__form" onsubmit={sendChatMessage}>
            <label class="ride-chat__label" for="passenger-chat-message">Votre message</label>
            <textarea
              id="passenger-chat-message"
              bind:value={chatDraft}
              maxlength="2000"
              rows="2"
              placeholder="Écrivez un message…"
              required
            ></textarea>
            <button class="auth-submit" type="submit" disabled={chatSending || !chatDraft.trim()}>
              {chatSending ? 'Envoi…' : 'Envoyer'}
            </button>
          </form>
        </section>
      {:else if offersError}
        <p class="ride-form__message ride-form__message--error" role="alert">{offersError}</p>
      {:else if offers.length === 0}
        <div class="passenger-offers__empty" role="status">
          <strong>{offersBusy ? 'Recherche des offres…' : 'Aucune offre pour le moment.'}</strong>
          <span>Les nouvelles propositions apparaîtront automatiquement ici.</span>
        </div>
      {:else}
        <div class="passenger-offers__list">
          {#each offers.filter((offer) => offer.status === 'pending') as offer (offer.id)}
            <article class="passenger-offer">
              <div class="passenger-offer__identity">
                {#if offer.proposer.photoUrl}
                  <img src={apiAssetUrl(offer.proposer.photoUrl)} alt="" class="passenger-offer__photo" />
                {:else}
                  <span class="passenger-offer__photo passenger-offer__photo--empty" aria-hidden="true">
                    {offer.proposer.name.slice(0, 1).toUpperCase()}
                  </span>
                {/if}
                <div>
                  <strong>{offer.proposer.name}</strong>
                  <span>{offerVehicle(offer)}</span>
                  {#if offer.proposer.phone}
                    <a class="ride-contact-phone" href={`tel:${offer.proposer.phone}`}>
                      <span aria-hidden="true">📞</span>
                      <span>{offer.proposer.phone}</span>
                    </a>
                  {/if}
                  {#if offerSecondsRemaining(offer) !== null}
                    <small class:passenger-offer__countdown--expired={offerSecondsRemaining(offer) === 0}>
                      {offerSecondsRemaining(offer) > 0
                        ? 'Le chauffeur attend votre réponse'
                        : 'Délai expiré · actualisation en cours'}
                    </small>
                    <div
                      class="passenger-offer__countdown"
                      role="progressbar"
                      aria-label="Temps restant pour répondre à l’accord du chauffeur"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={offerRemainingProgress(offer)}
                    >
                      <span
                        class="passenger-offer__countdown-fill"
                        style={`--passenger-offer-progress: ${offerRemainingProgress(offer) / 100}`}
                      ></span>
                    </div>
                  {/if}
                  <small>
                    {#if offer.proposer.ratingCount > 0}
                      ★ {offer.proposer.averageRating.toFixed(1)} · {offer.proposer.ratingCount} avis
                    {:else}
                      Nouveau chauffeur
                    {/if}
                  </small>
                </div>
              </div>
              <div class="passenger-offer__decision">
                <strong>{offer.amountMGA.toLocaleString('fr-FR')} Ar</strong>
                <div class="passenger-offer__actions">
                  <button
                    class="auth-submit"
                    type="button"
                    disabled={Boolean(acceptingOfferId || rejectingOfferId) || offerSecondsRemaining(offer) === 0}
                    onclick={() => acceptOffer(offer)}
                  >
                    {acceptingOfferId === offer.id ? 'Confirmation…' : 'Accepter'}
                  </button>
                  <button
                    class="passenger-offer__reject"
                    type="button"
                    disabled={Boolean(acceptingOfferId || rejectingOfferId) || offerSecondsRemaining(offer) === 0}
                    onclick={() => rejectOffer(offer)}
                  >
                    {rejectingOfferId === offer.id ? 'Refus…' : 'Refuser'}
                  </button>
                </div>
              </div>
            </article>
          {/each}
        </div>
        {#if offerActionMessage}
          <p class="ride-form__message" role="status">{offerActionMessage}</p>
        {/if}
        {#if offersError}
          <p class="ride-form__message ride-form__message--error" role="alert">{offersError}</p>
        {/if}
      {/if}
    </section>
    {/if}
  {/if}
  <RideHistory {token} role="passenger" />
</section>
