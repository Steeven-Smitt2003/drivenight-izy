# 005 — Afficher le délai de confirmation au passager

- **Statut** : DONE
- **Commit** : indisponible — dossier de travail sans dépôt Git
- **Gravité** : MEDIUM
- **Catégorie** : feedback d’état et accessibilité
- **Périmètre estimé** : 2 fichiers, environ 30 lignes

## Problème

Quand un chauffeur accepte le prix du passager, son offre expire 15 secondes
après sa création. Le passager voit actuellement le délai sous forme de
secondes numériques, ce qui ne correspond pas à la demande : montrer une
animation simple et sans chiffre, tout en gardant les actions accept/refuse
disponibles jusqu’à l’expiration réelle calculée par le serveur.

`client/src/PassengerRequest.svelte` calcule déjà le temps restant à partir de
`expiresAt` et d’une horloge actualisée toutes les 250 ms :

```js
function offerSecondsRemaining(offer) {
  if (!offer.expiresAt) return null;
  return Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - offersNow) / 1000));
}
```

Le composant affiche actuellement le nombre en secondes ici :

```svelte
{#if offerSecondsRemaining(offer) !== null}
  <small class:passenger-offer__countdown--expired={offerSecondsRemaining(offer) === 0}>
    {offerSecondsRemaining(offer) > 0
      ? `Le chauffeur attend votre réponse · ${offerSecondsRemaining(offer)} s`
      : 'Délai expiré · actualisation en cours'}
  </small>
{/if}
```

Les styles d’offre sont dans `client/src/styles.css` autour de
`.passenger-offer__identity small` et
`.passenger-offer__countdown--expired`.

## Cible

Pour chaque offre chauffeur avec `expiresAt`, garder un libellé visible sans
valeur numérique (« Le chauffeur attend votre réponse ») et ajouter dessous
une barre fine qui se vide linéairement pendant la durée réelle entre
`createdAt` et `expiresAt` (15 secondes dans le flux normal). Calculer la
progression à partir des horodatages absolus et de `offersNow`, pas d’un
compteur démarrant au rendu : une offre reçue tard ou un onglet revenu au
premier plan doit refléter le délai restant, sans prolonger les 15 secondes.
Quand le délai expire, afficher le texte existant « Délai expiré ·
actualisation en cours », vider la barre et conserver la désactivation actuelle
des boutons accepter/refuser.

Rendre la jauge accessible avec `role="progressbar"`, un nom accessible en
français (« Temps restant pour répondre à l’accord du chauffeur »), les bornes
0–100 et une valeur dérivée de la progression. Ne pas afficher de chiffre ou
de compte en secondes dans l’interface.

Style : rail discret de 4 px avec remplissage accentué, coins arrondis et
remplissage qui se réduit de gauche à droite (`transform: scaleX(...)`,
`transform-origin: left`). Mettre à jour la progression avec la boucle
existante de 250 ms et une transition CSS linéaire de 250 ms, sans animation
keyframes redémarrée à chaque rendu. Sous
`prefers-reduced-motion: reduce`, supprimer la transition de déplacement tout
en gardant l’indication visuelle de progression.

## Conventions du projet

- La logique des offres et du temps réel vit dans
  `client/src/PassengerRequest.svelte`.
- Les styles responsive partagés vivent dans `client/src/styles.css`.
- Le composant met déjà à jour `offersNow = Date.now()` toutes les 250 ms.
- Le temps restant est calculé par `offerSecondsRemaining`; réutiliser sa
  source de temps et ne pas ajouter un intervalle, une dépendance ou un délai
  de confirmation côté client.
- Les préférences de mouvement réduit sont déjà prises en charge dans
  `client/src/styles.css` par une media query globale.

## Étapes

1. Dans `PassengerRequest.svelte`, ajouter une fonction qui retourne la
   progression restante en pourcentage à partir de `createdAt`, `expiresAt` et
   `offersNow`, bornée à 0–100 et protégée contre une durée invalide ou nulle.
   Une offre sans `expiresAt` ne doit pas recevoir de jauge.
2. Remplacer le nombre de secondes visible par un libellé sans chiffre et,
   tant que l’offre est temporisée, une jauge `role="progressbar"` avec un nom
   accessible et une valeur numérique issue de cette progression.
3. Dans `styles.css`, créer les styles du rail et du remplissage. Appliquer le
   pourcentage au remplissage par une variable CSS ou un style Svelte sûr ;
   animer uniquement `transform`, en linéaire sur 250 ms. Ajouter la règle
   `prefers-reduced-motion` correspondante pour désactiver ce mouvement.
4. Conserver les états échus, la logique métier des actions, leur désactivation
   et les autres textes d’offre inchangés.

## Limites

- Ne pas modifier le serveur, les délais de 15 secondes, l’API ou les statuts
  des offres.
- Ne pas retirer ni changer les actions « Accepter » et « Refuser ».
- Ne pas afficher un nombre de secondes, même dans une étiquette visuelle.
- Ne pas démarrer un nouveau minuteur pour chaque offre ; utiliser
  `offersNow`, déjà entretenu par le composant.
- Ne pas ajouter de dépendance ni toucher aux composants chauffeur/admin.
- Si les extraits ou le mécanisme de temps ont changé, arrêter et signaler le
  décalage plutôt que d’improviser.

## Vérification

- **Mécanique** : lancer `npm test` et `npm run build`; les 34 tests serveur
  passent et le build client/PWA se termine sans erreur Svelte.
- **Ressenti** : depuis deux sessions de navigateur locales, publier une
  demande passager et faire accepter le prix depuis le chauffeur. Confirmer
  que le passager voit un libellé sans secondes, une barre qui se vide en
  environ 15 secondes, et les boutons actifs jusqu’à l’expiration puis
  désactivés. Recharger la page ou recevoir l’offre après quelques secondes :
  la progression doit reprendre selon `expiresAt`, sans redémarrer à 15 s.
  Activer `prefers-reduced-motion: reduce` et confirmer que la barre conserve
  son état sans déplacement animé.
- **Terminé quand** : le passager voit une indication de délai animée, sans
  chiffres de secondes, synchronisée avec l’expiration serveur et utilisable
  avec les technologies d’assistance.
