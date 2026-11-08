# 004 — Animer les changements d’état du trajet

- **Statut** : TODO
- **Commit** : indisponible — dossier de travail sans dépôt Git
- **Gravité** : LOW
- **Catégorie** : missed opportunities
- **Périmètre estimé** : 2 fichiers, environ 20 lignes

## Problème

La recherche insère et retire instantanément ses résultats ; les instructions
de choix d’un point sur la carte et la confirmation de publication apparaissent
également sans transition. La demande peut être publiée avec succès, mais
l’interface remplace directement l’action par le message de confirmation.

Les états conditionnels sont dans `client/src/PassengerRequest.svelte` :

```svelte
{#if places.items.length}
  <div class="ride-form__places" aria-label="Résultats de recherche">
    {#each places.items as place (place.id)}
```

```svelte
{#if pointOnMap}
  <p class="ride-form__message" role="status">
```

```svelte
{#if publishedRide}
  <div class="ride-form__success" role="status">
```

Le formulaire ne contient pas encore de directive de transition Svelte.

## Cible

Utiliser le helper intégré `fade` de Svelte pour les trois états conditionnels :

```svelte
<div transition:fade={{ duration: prefersReducedMotion() ? 100 : 160 }}>
```

Définir `prefersReducedMotion()` en lisant
`window.matchMedia('(prefers-reduced-motion: reduce)').matches`, sans
dépendance ni animation basée sur la position. Importer `fade` depuis
`svelte/transition`. La transition doit agir à l’entrée comme à la sortie, avec
160 ms en mode normal et 100 ms en mouvement réduit.

Appliquer le fondu aux résultats de recherche, au message « Touchez la carte »
et à la confirmation publiée. Ne pas retarder la validation, la publication,
le focus, ni l’activation des commandes.

## Conventions du projet

- Le formulaire passager est un composant Svelte autonome :
  `client/src/PassengerRequest.svelte`.
- Les transitions sont en CSS/Svelte ; aucune bibliothèque de mouvement
  externe n’est installée.
- Les transitions UI doivent rester sous 300 ms ; garder le fondu à 160 ms,
  ou 100 ms si le mouvement réduit est activé.
- Le message de confirmation reste visible jusqu’à ce que le passager crée une
  nouvelle demande.

## Étapes

1. Importer `fade` depuis `svelte/transition`.
2. Ajouter le helper qui lit la préférence `prefers-reduced-motion`.
3. Ajouter `transition:fade` aux résultats de recherche, à l’instruction
   cartographique et à la confirmation de publication, avec les durées exactes
   définies ci-dessus.
4. Vérifier les transitions dans les deux sens lorsque les états apparaissent
   et disparaissent.

## Limites

- Ne pas déplacer ou redimensionner les panneaux pendant les transitions.
- Ne pas ajouter de délai avant les actions réseau ou les commandes.
- Ne pas modifier le texte, la logique métier, la carte ou les résultats
  d’adresse.
- Ne pas ajouter de dépendance.
- Si les blocs conditionnels ne correspondent plus aux extraits, arrêter et
  signaler le décalage au lieu d’improviser.

## Vérification

- **Mécanique** : lancer `npm run build`.
- **Ressenti** : lancer une recherche, sélectionner un résultat puis choisir un
  point sur la carte ; publier une demande. Chaque résultat, instruction et
  confirmation doit apparaître et disparaître sans saut, sans retarder les
  contrôles. Avec `prefers-reduced-motion: reduce`, vérifier que seuls de
  courts fondus subsistent.
- **Terminé quand** : les trois états sont animés à l’entrée et à la sortie,
  les interactions restent immédiates et le build passe.
