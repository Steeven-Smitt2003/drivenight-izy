# 003 — Respecter le mouvement réduit

- **Statut** : TODO
- **Commit** : indisponible — dossier de travail sans dépôt Git
- **Gravité** : MEDIUM
- **Catégorie** : accessibility
- **Périmètre estimé** : 1 fichier, environ 15 lignes

## Problème

La préférence « réduire les animations » raccourcit indistinctement toute
animation et toute transition à `0.01ms`. Cela supprime aussi les retours utiles
des boutons, plutôt que de garder un feedback doux tout en supprimant le
mouvement décoratif.

`client/src/styles.css:1528-1535` :

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

L’animation décorative qui continue à bouger est la ligne de trajet sur l’écran
d’accueil, `client/src/styles.css:754` :

```css
  animation: route-flow 18s linear infinite;
```

Après le plan 002, les boutons disposent aussi d’un état actif transformé qu’il
faut neutraliser dans ce mode.

## Cible

Remplacer la règle universelle par des règles ciblées qui :

- arrêtent l’animation décorative continue `.route-art__journey` avec
  `animation: none`;
- désactivent la translation hover de `.auth-submit` et de
  `.auth-start svg`, ainsi que l’échelle `:active` ajoutée par le plan 002;
- gardent les changements lisibles de couleur, opacité et ombre avec une durée
  de `100ms` et la courbe `var(--ease-out)`;
- ne forcent pas toutes les autres transitions de l’application à `0.01ms`.

Ne pas désactiver les fondus de feedback du plan 004 : ils ne déplacent pas le
contenu et doivent rester courts.

## Conventions du projet

- Le respect du réglage système se fait dans `client/src/styles.css`.
- `--ease-out` est déclaré par le plan 001.
- Le feedback tactile `scale(0.97)` est ajouté par le plan 002 ; exécuter ce
  plan après le 002.
- L’animation décorative est une ligne SVG en pointillés, pas une information
  requise pour comprendre le formulaire.

## Étapes

1. Remplacer la règle globale `prefers-reduced-motion` par une règle ciblée
   pour `.route-art__journey`.
2. Neutraliser les propriétés `transform` de hover et d’appui dans cette
   préférence, sans effacer le focus clavier.
3. Garder les feedbacks de couleur, opacité et ombre à `100ms var(--ease-out)`.
4. Garder `scroll-behavior: auto` pour ce réglage.

## Limites

- Ne pas enlever les indicateurs de focus visibles.
- Ne pas modifier la préférence par défaut, le thème ou les interactions de la
  carte Leaflet.
- Ne pas réintroduire une règle universelle qui réduit les transitions à zéro.
- Ne pas ajouter de dépendance.
- Si les états actifs du plan 002 ne sont pas présents, arrêter et signaler la
  dépendance manquante.

## Vérification

- **Mécanique** : lancer `npm run build`.
- **Ressenti** : dans DevTools, basculer `prefers-reduced-motion: reduce`.
  L’illustration doit s’immobiliser, les boutons ne doivent plus se déplacer,
  mais un clic doit rester confirmé par un retour bref de couleur/ombre.
  Désactiver la préférence et vérifier que les mouvements normaux reviennent.
- **Terminé quand** : le mouvement décoratif et les transformations sont
  supprimés en mode réduit, les feedbacks d’interaction restent visibles, et
  les autres transitions ne sont pas annulées globalement.
