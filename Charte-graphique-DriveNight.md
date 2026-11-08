# Charte graphique — DriveNight

Document de référence synthétisant l'identité visuelle actuellement utilisée par l'application. Les valeurs ci-dessous sont relevées dans les styles et composants du projet ; elles décrivent l'interface existante, et ne constituent pas une refonte.

## Identité

- **Nom :** DriveNight
- **Promesse visuelle :** un service de trajets urbains clair, fiable et contemporain, pensé d'abord pour le mobile.
- **Logo :** utiliser les fichiers fournis, sans les redessiner ni les renommer :
  - `assets/img/drivenight-logo.png` — logo avec nom, pour les en-têtes et espaces de marque ;
  - `assets/img/drivenight-mark.png` — symbole seul, pour les petits emplacements ;
  - `public/drivenight-app-icon.png` — icône de l'application.
- Garder les proportions du logo, préserver son contraste et éviter de le placer sur un fond visuellement chargé.
- Les icônes fonctionnelles de l'interface sont rendues en SVG ; ne pas utiliser de police d'icônes.

## Palette principale

| Rôle | Clair | Sombre | Usage |
|---|---|---|---|
| Bleu principal | `#0C73C7` | `#0C73C7` | Actions principales, liens, focus, repères actifs |
| Bleu au survol | `#095FA8` | `#095FA8` | Survol des actions principales |
| Bleu doux | `#EAF4FC` | `#1B3852` | Fonds d'accent, sélection et états informatifs |
| Texte principal | `#111B2B` | `#EDF2F7` | Titres et texte courant |
| Texte secondaire | `#78827B` | `#A4AFBD` | Descriptions, aides et métadonnées |
| Fond général | `#F4F7FA` | `#101A2A` | Arrière-plan de l'application |
| Surface / carte | `#FFFFFF` | `#1A2636` | Formulaires, panneaux et cartes |
| Bordure | `#E2E8EE` | `#354254` | Séparation des surfaces et champs |
| Accent d'état « en ligne » | `#89B94D` | `#89B94D` | Disponibilité et indicateurs positifs |
| Accent tarif / attente | `#E2BD64` | `#E2BD64` | État de recherche et repères tarifaires |

Les couleurs sémantiques d'erreur, d'avertissement et de succès doivent rester distinctes du bleu de marque et conserver un contraste lisible avec leur surface. Ne pas employer le bleu principal pour signaler une erreur.

## Thèmes

L'application propose les modes **clair**, **sombre** et **système**. Le choix est mémorisé sous `drivenight.theme`, appliqué au chargement et reflété dans la couleur de thème de la barre du navigateur/PWA :

- Clair : `#F4F7FA`
- Sombre : `#101A2A`

Le thème sombre utilise des surfaces bleu nuit (`#1A2636`, `#172335`) plutôt que du noir pur. Le texte et les bordures doivent être adaptés avec le thème ; éviter de laisser des champs, menus, modales ou contrôles de carte avec leurs couleurs claires par défaut.

## Typographie

- **Texte courant et interface :** DM Sans, avec une police sans empattement générique en repli.
- **Titres, marque et chiffres mis en avant :** Manrope, avec une police sans empattement générique en repli.
- Les titres sont généralement en graisse 700–800 ; les libellés et contrôles utilisent surtout 600–800.
- Garder une hiérarchie concise : titres distinctifs, libellés courts, descriptions faciles à parcourir sur petit écran.
- Les polices web peuvent ne pas être disponibles hors ligne ; les replis système doivent rester acceptables.

## Formes, surfaces et composition

- Cartes principales : coins arrondis généreux, rayon de référence **22 px** ; réduire vers **18 px** sur certains éléments mobiles.
- Champs et boutons : formes arrondies, généralement **10–14 px**, avec bordure visible et état de focus net.
- Ombres : douces et discrètes, destinées à distinguer les surfaces sans alourdir l'écran.
- Mise en page mobile-first : parcours de réservation immédiatement identifiable, contenu aéré, contrôles adaptés au toucher.
- Respecter les zones de sécurité (`safe areas`) et les encoches des appareils, notamment dans les en-têtes.
- Conserver une largeur de lecture maîtrisée sur les grands écrans et une navigation compacte sur mobile.

## Composants et états

- **Action principale :** fond bleu `#0C73C7`, libellé contrasté, survol `#095FA8` ; désactiver clairement l'action pendant le chargement ou lorsqu'elle n'est pas disponible.
- **Action secondaire :** surface discrète, bordure visible, libellé lisible ; ne pas lui donner la même priorité visuelle que l'action principale.
- **Focus clavier :** contour visible de 3 px en bleu principal, avec décalage.
- **Statut en ligne :** point vert et libellé explicite ; ne pas communiquer le statut par la couleur seule.
- **Erreurs et notifications :** message textuel clair, surface et bordure différenciées ; préserver le contexte de l'action concernée.
- **États des trajets :** conserver une progression intelligible (recherche, proposition, chauffeur en route, arrivé, course en cours, terminée ou annulée).
- **Cartes :** les tuiles Leaflet/OpenStreetMap sont assombries en mode sombre ; garder l'attribution cartographique lisible.

## Ton de marque et contenu

- Employer un français direct, accueillant et concret.
- Préférer des phrases courtes et des libellés orientés action : publier une course, proposer un prix, accepter une offre, envoyer un message.
- Rester transparent sur les états, erreurs, permissions de localisation et chargements.
- Ne pas promettre une disponibilité, une sécurité ou une fonctionnalité qui n'est pas effectivement assurée.

## Accessibilité et compatibilité

- Viser un contraste suffisant en clair comme en sombre ; vérifier en particulier les textes secondaires, badges et textes posés sur le bleu.
- Toute commande doit avoir un libellé compréhensible, une zone tactile confortable et un état de focus visible.
- Ne jamais distinguer les rôles, statuts ou erreurs uniquement par la couleur.
- Respecter la préférence de réduction des animations.
- Garder les comportements compatibles avec une WebView Capacitor : interface tactile, zones de sécurité, navigation dans la même fenêtre et solutions de repli aux API web non disponibles.

## Références dans le projet

- Couleurs, composants et thèmes : `src/styles.css`
- Styles de connexion et d'inscription : `src/components/AuthPage.css`
- Application du thème et couleur de navigateur : `src/lib/theme.js` et `index.html`
- Composant de marque : `src/components/DriveNightBrand.jsx`
- Images de marque : `assets/img/` et `public/drivenight-app-icon.png`
