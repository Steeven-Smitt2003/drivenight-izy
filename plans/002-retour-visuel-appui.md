# 002 — Ajouter un retour visuel à l’appui

- **Statut** : TODO
- **Commit** : indisponible — dossier de travail sans dépôt Git
- **Gravité** : LOW
- **Catégorie** : purpose & frequency
- **Périmètre estimé** : 1 fichier, environ 25 lignes

## Problème

Les principaux boutons offrent une transition au survol, mais pas de retour
distinct lorsque l’utilisateur appuie. Sur téléphone, le survol n’est pas un
signal fiable. L’action principale et les commandes de recherche paraissent
donc moins immédiates au toucher.

`client/src/styles.css:580-598` :

```css
.auth-submit {
  color: #fff;
  background: var(--blue);
  transition:
    background-color 160ms ease,
    box-shadow 160ms ease,
    transform 160ms ease;
}

.auth-submit:hover:not(:disabled) {
  background: var(--blue-hover);
  box-shadow: 0 8px 20px color-mix(in srgb, var(--blue) 22%, transparent);
  transform: translateY(-1px);
}
```

`.auth-secondary`, `.ride-form__search-button` et `.ride-form__map-choice` ont
également des états de survol ou d’apparence, mais aucun état `:active`.

## Cible

Réutiliser `--ease-out` déclaré par le plan 001 et ajouter un retour subtil
uniquement sur les commandes activables :

```css
.auth-submit:hover:not(:disabled):active,
.auth-secondary:active,
.ride-form__search-button:active:not(:disabled),
.ride-form__map-choice:active:not(:disabled) {
  transform: scale(0.97);
}
```

Ajouter ou harmoniser les transitions `transform 160ms var(--ease-out)` sur ces
boutons. Pour `.auth-submit`, garder les transitions de couleur et d’ombre déjà
présentes et remplacer seulement leur easing si nécessaire. L’état actif de
`.auth-submit` doit être plus spécifique que son état `:hover` pour éviter que
`translateY(-1px)` masque l’écrasement.

## Conventions du projet

- Les boutons principaux et secondaires sont définis dans
  `client/src/styles.css`.
- Les durées de feedback d’appui sont comprises entre 100 et 160 ms ; utiliser
  exactement 160 ms.
- La courbe `--ease-out` est définie par le plan 001 : `cubic-bezier(0.23, 1,
  0.32, 1)`.
- Garder les styles tactiles existants : ne pas s’appuyer sur `:hover` seul.

## Étapes

1. Ajouter la transition `transform 160ms var(--ease-out)` aux boutons concernés.
2. Ajouter l’état `:active` avec `scale(0.97)`.
3. Vérifier la priorité CSS entre l’état actif et le survol de `.auth-submit`.
4. Ne pas ajouter de translation sur les boutons secondaires.

## Limites

- Ne pas modifier les libellés, tailles tactiles, couleurs ou structure Svelte.
- Ne pas appliquer l’effet aux liens, champs ou commandes Leaflet.
- Ne pas ajouter de dépendance.
- Si l’état hover de l’action principale ne correspond plus à l’extrait, arrêter
  et signaler le décalage.

## Vérification

- **Mécanique** : lancer `npm run build`.
- **Ressenti** : cliquer et toucher l’action principale, les boutons
  « Chercher », le bouton de choix sur carte et l’action secondaire. L’appui
  doit être perceptible mais discret ; le bouton ne doit pas sauter en relâchant.
- **Terminé quand** : l’appui donne un retour via `scale(0.97)` en 160 ms, y
  compris au tactile, sans perturber le survol.
