# 001 — Calmer le focus des champs

- **Statut** : TODO
- **Commit** : indisponible — dossier de travail sans dépôt Git
- **Gravité** : MEDIUM
- **Catégorie** : fréquence et cohésion
- **Périmètre estimé** : 1 fichier, environ 20 lignes

## Problème

Les champs de connexion et d’inscription font défiler leur bordure en boucle
pendant toute la saisie. La même animation est appliquée aux champs texte et
aux listes de sélection, qui sont utilisés fréquemment.

`client/src/styles.css:376` :

```css
  background-size: 100% 100%, 220% 220%;
  animation: field-border-flow 2.8s linear infinite;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--field-focus) 23%, transparent),
    0 0 18px color-mix(in srgb, var(--blue) 22%, transparent);
```

`client/src/styles.css:422` :

```css
  background-size: 14px 14px, 100% 100%, 220% 220%;
  background-position: right 14px center, 0 0, 220% 0;
  background-repeat: no-repeat, no-repeat, no-repeat;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--field-focus) 23%, transparent),
    0 0 18px color-mix(in srgb, var(--blue) 22%, transparent);
  animation: select-field-border-flow 2.8s linear infinite;
```

Les keyframes associés sont `field-border-flow` et
`select-field-border-flow` vers les lignes 907–917 du même fichier.

## Cible

Dans `:root`, ajouter le jeton partagé :

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
```

Pour les champs texte focalisés, garder la bordure contrastée et l’ombre de
focus, supprimer l’animation et remplacer la transition de boîte par :

```css
transition: box-shadow 160ms var(--ease-out);
```

Pour les listes de sélection, conserver l’icône, le fond et le dégradé de
bordure statique. Supprimer l’animation et les positions/surfaces surdimensionnées
utilisées seulement pour la boucle. Le focus reste immédiatement visible grâce
à l’ombre déjà présente. Supprimer les deux keyframes s’ils ne sont plus
référencés.

Ne pas modifier les champs du formulaire trajet ni l’animation décorative de
l’illustration d’accueil.

## Conventions du projet

- La feuille de style globale est `client/src/styles.css`.
- Les animations actuelles utilisent CSS pur, sans bibliothèque d’animation.
- Garder les couleurs de focus existantes : `--blue`, `--field-focus` et
  `--border`.
- La valeur de `--ease-out` vient du catalogue de motion du projet :
  `cubic-bezier(0.23, 1, 0.32, 1)`.

## Étapes

1. Déclarer `--ease-out` dans `:root`.
2. Remplacer la transition focus de `.auth-form input` par une transition
   `box-shadow 160ms var(--ease-out)`.
3. Supprimer `field-border-flow` et `select-field-border-flow` des états focus,
   en laissant un dégradé de bordure fixe.
4. Supprimer les keyframes qui ne sont alors plus utilisés.

## Limites

- Ne pas changer le HTML/Svelte, les couleurs, la taille des champs ou le
  contenu des formulaires.
- Ne pas modifier le `route-flow` de l’illustration ni les styles de la carte.
- Ne pas ajouter de dépendance.
- Si les extraits ne correspondent plus au code présent, arrêter et signaler
  le décalage plutôt que de réinterpréter le plan.

## Vérification

- **Mécanique** : lancer `npm run build`.
- **Ressenti** : ouvrir les formulaires connexion et inscription, parcourir les
  champs au clavier et cliquer dans plusieurs champs. La bordure doit rester
  claire et stable ; le focus doit s’établir rapidement, sans balayage répété.
- **Terminé quand** : aucun keyframe de balayage ne s’applique aux champs
  d’authentification, le focus reste visible et le build passe.
