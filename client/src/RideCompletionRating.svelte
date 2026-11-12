<script>
  import { apiAssetUrl, apiFetch } from './lib/api.js';

  let {
    token,
    role,
    ride,
    onClose,
    onRated = () => {},
  } = $props();

  let stars = $state(0);
  let hoverStars = $state(0);
  let comment = $state('');
  let submitting = $state(false);
  let submitted = $state(false);
  let error = $state('');

  function ratingLabel(value) {
    return {
      0: 'Choisissez une note',
      1: 'À améliorer',
      2: 'Moyen',
      3: 'Bien',
      4: 'Très bien',
      5: 'Excellent',
    }[value] ?? '';
  }

  function formatPrice(amount) {
    return amount === null || amount === undefined
      ? 'Prix non convenu'
      : `${new Intl.NumberFormat('fr-FR').format(amount)} Ar`;
  }

  async function submitRating(event) {
    if (event) event.preventDefault();
    if (stars < 1) {
      error = 'Veuillez sélectionner une note de 1 à 5 étoiles avant d’envoyer.';
      return;
    }
    submitting = true;
    error = '';
    try {
      const response = await apiFetch(`/api/rides/${encodeURIComponent(ride.id)}/ratings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stars: Number(stars),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RATING_FAILED');
      submitted = true;
      onRated({ stars, comment: comment.trim(), response: body });
    } catch (requestError) {
      if (requestError.message === 'RATING_ALREADY_SUBMITTED') {
        error = 'Vous avez déjà évalué cette course. Merci !';
        submitted = true;
      } else if (requestError.message === 'RIDE_NOT_COMPLETED') {
        error = 'La course n’est pas encore marquée comme terminée.';
      } else {
        error = 'Votre évaluation n’a pas pu être enregistrée. Veuillez réessayer.';
      }
    } finally {
      submitting = false;
    }
  }
</script>

<section class="ride-completion-card" aria-labelledby="completion-title">
  <div class="ride-completion-card__badge" aria-hidden="true">
    <span>✓</span>
  </div>

  <header class="ride-completion-card__header">
    <h2 id="completion-title" class="ride-completion-card__title">
      Course terminée !
    </h2>
    <p class="ride-completion-card__subtitle">
      {#if role === 'passenger'}
        {#if ride.counterparty?.name}
          Merci d'avoir voyagé avec <strong>{ride.counterparty.name}</strong>. Donnez votre avis pour aider la communauté.
        {:else}
          Votre course est terminée. Donnez votre avis pour aider la communauté.
        {/if}
      {:else}
        {#if ride.counterparty?.name}
          Vous avez terminé la course avec <strong>{ride.counterparty.name}</strong>. Comment s'est passé le trajet ?
        {:else}
          Course terminée. Comment s'est passé le trajet avec votre passager ?
        {/if}
      {/if}
    </p>
  </header>

  <div class="ride-completion-card__recap">
    {#if ride.counterparty}
      <div class="ride-completion-card__person">
        {#if ride.counterparty.photoUrl}
          <img src={apiAssetUrl(ride.counterparty.photoUrl)} alt="" class="ride-completion-card__photo" />
        {:else}
          <span class="ride-completion-card__photo ride-completion-card__photo--empty" aria-hidden="true">
            {(ride.counterparty.name ?? 'U').slice(0, 1).toUpperCase()}
          </span>
        {/if}
        <div>
          <strong>{ride.counterparty.name ?? 'Utilisateur'}</strong>
          <span>{role === 'passenger' ? 'Chauffeur' : 'Passager'}</span>
        </div>
      </div>
    {/if}
    {#if ride.origin?.label && ride.destination?.label}
      <div class="ride-completion-card__route">
        <div class="ride-completion-card__route-line">
          <span class="ride-completion-card__route-dot" aria-hidden="true"></span>
          <span>{ride.origin.label}</span>
        </div>
        <div class="ride-completion-card__route-line">
          <span class="ride-completion-card__route-dot ride-completion-card__route-dot--dest" aria-hidden="true"></span>
          <span>{ride.destination.label}</span>
        </div>
      </div>
    {/if}
    {#if ride.agreedPriceMGA !== undefined && ride.agreedPriceMGA !== null}
      <div class="ride-completion-card__price">
        <span>Montant convenu :</span>
        <strong>{formatPrice(ride.agreedPriceMGA)}</strong>
      </div>
    {/if}
  </div>

  {#if submitted}
    <div class="ride-completion-card__success" role="status">
      <div class="ride-completion-card__stars-display" aria-hidden="true">
        {'★'.repeat(stars || 5)}{'☆'.repeat(Math.max(0, 5 - (stars || 5)))}
      </div>
      <strong>Merci pour votre évaluation !</strong>
      <p>Votre avis contribue à la qualité et la confiance sur DriveNight.</p>
      <div class="ride-completion-card__actions">
        <button class="auth-submit" type="button" onclick={onClose}>
          {role === 'passenger' ? 'Commander un nouveau trajet' : 'Retour aux demandes'}
        </button>
      </div>
    </div>
  {:else}
    <form class="ride-completion-card__form" onsubmit={submitRating}>
      <div class="ride-completion-card__stars-wrapper">
        <span id="rate-stars-label" class="ride-completion-card__label">Votre note</span>
        <div
          class="ride-completion-card__stars-picker"
          role="group"
          aria-labelledby="rate-stars-label"
          onmouseleave={() => { hoverStars = 0; }}
        >
          {#each [1, 2, 3, 4, 5] as starValue}
            <button
              class="ride-completion-card__star-btn"
              class:ride-completion-card__star-btn--active={starValue <= (hoverStars || stars)}
              type="button"
              aria-label={`${starValue} étoile${starValue > 1 ? 's' : ''} - ${ratingLabel(starValue)}`}
              aria-pressed={stars === starValue}
              disabled={submitting}
              onmouseenter={() => { hoverStars = starValue; }}
              onclick={() => { stars = starValue; error = ''; }}
            >
              {starValue <= (hoverStars || stars) ? '★' : '☆'}
            </button>
          {/each}
        </div>
        <p class="ride-completion-card__rating-text" aria-live="polite">
          {ratingLabel(hoverStars || stars)}
        </p>
      </div>

      <div class="ride-completion-card__comment-group">
        <label for="completion-rating-comment" class="ride-completion-card__label">
          Commentaire (facultatif)
        </label>
        <textarea
          id="completion-rating-comment"
          class="ride-completion-card__textarea"
          rows="3"
          maxlength="1000"
          placeholder={role === 'passenger'
            ? 'Ponctualité, courtoisie, conduite… Partagez votre expérience'
            : 'Ponctualité, politesse… Laissez un mot sur le passager'}
          bind:value={comment}
          disabled={submitting}
        ></textarea>
      </div>

      {#if error}
        <p class="ride-completion-card__error" role="alert">{error}</p>
      {/if}

      <div class="ride-completion-card__actions">
        <button
          class="auth-submit ride-completion-card__submit"
          type="submit"
          disabled={submitting || stars < 1}
        >
          {submitting ? 'Envoi en cours…' : 'Envoyer mon avis'}
        </button>
        <button
          class="auth-secondary ride-completion-card__skip"
          type="button"
          disabled={submitting}
          onclick={onClose}
        >
          {role === 'passenger' ? 'Passer pour l’instant' : 'Fermer'}
        </button>
      </div>
    </form>
  {/if}
</section>
