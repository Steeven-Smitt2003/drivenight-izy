<script>
  import { apiFetch } from './lib/api.js';

  let { token, role } = $props();
  let rides = $state([]);
  let visible = $state(false);
  let loading = $state(false);
  let error = $state('');
  let ratingDrafts = $state({});
  let ratingErrors = $state({});
  let ratingBusyRideId = $state('');
  let loaded = false;

  const headers = () => ({ authorization: `Bearer ${token}` });

  async function loadHistory() {
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/rides/history', { headers: headers() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RIDE_HISTORY_UNAVAILABLE');
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      rides = (body.rides ?? []).filter((ride) => {
        const timestamp = new Date(ride.requestedAt ?? ride.createdAt).getTime();
        return !Number.isNaN(timestamp) && timestamp >= oneDayAgo;
      });
      loaded = true;
    } catch {
      error = 'L’historique ne peut pas être chargé. Vérifiez votre connexion puis réessayez.';
    } finally {
      loading = false;
    }
  }

  async function toggleHistory() {
    visible = !visible;
    if (visible && !loaded) await loadHistory();
  }

  function statusLabel(status) {
    return {
      searching: 'Recherche en cours',
      negotiating: 'Négociation',
      driver_en_route: 'Chauffeur en route',
      driver_arrived: 'Chauffeur arrivé',
      in_progress: 'En cours',
      completed: 'Terminée',
      cancelled: 'Annulée',
    }[status] ?? status;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  function formatPrice(amount) {
    return amount === null || amount === undefined
      ? 'Prix non convenu'
      : `${new Intl.NumberFormat('fr-FR').format(amount)} Ar`;
  }

  function ratingLabel(stars) {
    return {
      0: 'Choisissez une note',
      1: 'À améliorer',
      2: 'Moyen',
      3: 'Bien',
      4: 'Très bien',
      5: 'Excellent',
    }[stars];
  }

  function selectedRating(rideId) {
    return Number(ratingDrafts[rideId]?.stars ?? 0);
  }

  async function submitRating(ride, event) {
    event.preventDefault();
    const draft = ratingDrafts[ride.id] ?? { stars: '', comment: '' };
    if (selectedRating(ride.id) < 1) {
      ratingErrors[ride.id] = 'Choisissez une note avant d’envoyer votre avis.';
      return;
    }

    ratingBusyRideId = ride.id;
    ratingErrors[ride.id] = '';
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(ride.id)}/ratings`, {
        method: 'POST',
        headers: {
          ...headers(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stars: Number(draft.stars),
          ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RATING_FAILED');
      rides = rides.map((item) => item.id === ride.id
        ? { ...item, myRating: body.rating }
        : item);
    } catch (requestError) {
      ratingErrors[ride.id] = requestError.message === 'RATING_ALREADY_SUBMITTED'
        ? 'Vous avez déjà évalué cette course. Actualisez l’historique.'
        : requestError.message === 'RIDE_NOT_COMPLETED'
          ? 'Vous pourrez évaluer ce trajet lorsqu’il sera terminé.'
          : 'Votre évaluation n’a pas pu être enregistrée. Réessayez.';
    } finally {
      ratingBusyRideId = '';
    }
  }
</script>

<section class="ride-history" aria-labelledby={`ride-history-title-${role}`}>
  <div class="ride-history__heading">
    <div>
      <p class="ride-history__eyebrow">Vos trajets</p>
      <h2 id={`ride-history-title-${role}`}>Historique des courses</h2>
      <p class="ride-history__note">Les courses de plus de 24 heures s’effacent automatiquement.</p>
    </div>
    <button class="auth-secondary" type="button" aria-expanded={visible} onclick={toggleHistory}>
      {visible ? 'Masquer' : 'Afficher l’historique'}
    </button>
  </div>

  {#if visible}
    <div class="ride-history__content">
      {#if loading}
        <p class="ride-history__empty" role="status">Chargement de votre historique…</p>
      {:else if error}
        <p class="ride-history__error" role="alert">{error}</p>
        <button class="driver-refresh" type="button" onclick={loadHistory}>Réessayer</button>
      {:else if rides.length === 0}
        <p class="ride-history__empty" role="status">Aucune course enregistrée dans les dernières 24 heures.</p>
      {:else}
        <div class="ride-history__list">
          {#each rides as ride (ride.id)}
            <article class="ride-history__item">
              <div class="ride-history__top">
                <span class="ride-history__status" class:ride-history__status--completed={ride.status === 'completed'}>{statusLabel(ride.status)}</span>
                <time datetime={ride.completedAt ?? ride.cancelledAt ?? ride.acceptedAt ?? ride.requestedAt}>
                  {formatDate(ride.completedAt ?? ride.cancelledAt ?? ride.acceptedAt ?? ride.requestedAt)}
                </time>
              </div>
              <div class="ride-history__route">
                <div><span class="ride-history__dot" aria-hidden="true"></span><span>{ride.origin.label}</span></div>
                <div><span class="ride-history__dot ride-history__dot--destination" aria-hidden="true"></span><span>{ride.destination.label}</span></div>
              </div>
              <div class="ride-history__bottom">
                <span>{role === 'passenger' ? 'Chauffeur' : 'Passager'} : {ride.counterparty?.name ?? 'Non attribué'}</span>
                <strong>{formatPrice(ride.agreedPriceMGA)}</strong>
              </div>
              {#if ride.status === 'completed' && !ride.myRating && ride.counterparty}
                <form class="ride-rating" onsubmit={(event) => submitRating(ride, event)}>
                  <span id={`ride-rating-stars-${ride.id}`} class="ride-rating__label">Votre note</span>
                  <div class="ride-rating__stars" role="group" aria-labelledby={`ride-rating-stars-${ride.id}`}>
                    {#each [1, 2, 3, 4, 5] as stars}
                      <button
                        class="ride-rating__star"
                        class:ride-rating__star--selected={stars <= selectedRating(ride.id)}
                        type="button"
                        aria-label={`${stars} étoile${stars > 1 ? 's' : ''} — ${ratingLabel(stars)}`}
                        aria-pressed={selectedRating(ride.id) === stars}
                        disabled={ratingBusyRideId === ride.id}
                        onclick={() => {
                          ratingDrafts[ride.id] = { ...(ratingDrafts[ride.id] ?? {}), stars: String(stars) };
                          ratingErrors[ride.id] = '';
                        }}
                      >
                        {stars <= selectedRating(ride.id) ? '★' : '☆'}
                      </button>
                    {/each}
                    <span class="ride-rating__description" aria-live="polite">
                      {ratingLabel(selectedRating(ride.id))}
                    </span>
                  </div>
                  <label for={`ride-rating-comment-${ride.id}`}>Commentaire (facultatif)</label>
                  <textarea
                    id={`ride-rating-comment-${ride.id}`}
                    maxlength="1000"
                    rows="2"
                    placeholder="Partagez votre expérience…"
                    value={ratingDrafts[ride.id]?.comment ?? ''}
                    oninput={(event) => { ratingDrafts[ride.id] = { ...(ratingDrafts[ride.id] ?? {}), comment: event.currentTarget.value }; }}
                  ></textarea>
                  {#if ratingErrors[ride.id]}
                    <p class="ride-history__error" role="alert">{ratingErrors[ride.id]}</p>
                  {/if}
                  <button class="auth-submit" type="submit" disabled={ratingBusyRideId === ride.id || selectedRating(ride.id) < 1}>
                    {ratingBusyRideId === ride.id ? 'Envoi…' : 'Envoyer mon avis'}
                  </button>
                </form>
              {:else if ride.myRating}
                <p class="ride-rating__submitted" role="status">
                  Votre note : <strong>{'★'.repeat(ride.myRating.stars)}{'☆'.repeat(5 - ride.myRating.stars)}</strong>
                  {#if ride.myRating.comment}<span> · {ride.myRating.comment}</span>{/if}
                </p>
              {/if}
            </article>
          {/each}
        </div>
        <button class="driver-refresh ride-history__refresh" type="button" disabled={loading} onclick={loadHistory}>
          Actualiser l’historique
        </button>
      {/if}
    </div>
  {/if}
</section>
