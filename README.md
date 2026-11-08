# DriveNight

Application web locale de VTC à Antananarivo. Passagers et chauffeurs conviennent
du prix de la course par offres et contre-offres ; DriveNight ne propose ni
paiement, ni portefeuille, ni commission, ni abonnement. Le règlement convenu
se fait directement entre les personnes, hors de l’application.

## Prérequis

- Node.js 20.19+ (Node.js 26 recommandé)
- npm 10+

L’interface embarque Cantarell, police libre sous licence SIL Open Font License
1.1, afin de conserver la même typographie hors ligne et sans service externe.
Le texte de licence est fourni dans `client/public/fonts/OFL-1.1.txt`.
Les icônes de l’interface proviennent du projet Lucide (`client/public/icons/`)
et sont distribuées sous licence ISC, reproduite dans
`client/public/licenses/LUCIDE-LICENSE.txt`.

## Installation et lancement local

```sh
npm install
cp .env.example .env
npm run dev
```

Ouvrir <http://127.0.0.1:5173>. Vite transmet `/api` au serveur Fastify sur
`127.0.0.1:3000`. La base SQLite est créée dans `server/data/drivenight.sqlite`
au premier démarrage, avec son schéma versionné et des données de démonstration
à Antananarivo.

## Préparation PostgreSQL pour une bêta

SQLite reste le chemin local et celui des tests. Pour préparer une instance
PostgreSQL managée (Neon ou un autre fournisseur), renseigner `DATABASE_URL`
dans `.env` avec l’URL fournie par le fournisseur. Le serveur applique ses
migrations PostgreSQL versionnées au démarrage ; aucune base distante n’est
contactée tant que cette variable n’est pas renseignée. Ne jamais committer
l’URL ni la placer dans une variable client `VITE_*`.

Les données de démonstration restent automatiques uniquement pour SQLite.
PostgreSQL démarre sans compte de démonstration ni identifiant administrateur ;
`SEED_DEMO_DATA=true` est une option explicite réservée au développement et
refusée en production. En production, définir aussi un `JWT_SECRET` fort et
unique. Une offre PostgreSQL gratuite peut convenir à une bêta limitée, mais
il faut anticiper les quotas, les réveils à froid et des sauvegardes/rétentions
limitées ; elle ne constitue pas à elle seule une garantie de disponibilité ou
de reprise. Aucun fournisseur, déploiement, service payant ou client Android
n’est configuré par ce projet.

Pour saisir les réglages de la bêta sans afficher les secrets, lancer
`bash scripts/setup-beta.sh` depuis n’importe quel dossier. L’assistant guide
la création du projet Neon et la configuration Brevo, puis écrit les valeurs
dans `.env` (ignoré par Git et protégé en permissions locales). Il n’envoie
aucun e-mail automatiquement. La connexion à Neon et l’application des
migrations PostgreSQL demandent une confirmation dédiée ; si elles sont
différées, le premier démarrage du serveur avec `DATABASE_URL` renseigné
appliquera les migrations. L’activation de l’envoi Brevo et l’ouverture de
l’application pour un test réel sont également confirmées séparément.

### Vérification d’e-mail

Pour une bêta, l’API peut envoyer les codes de vérification via l’API
transactionnelle de **Brevo Free**. Le forfait gratuit affiche actuellement un
quota de 300 e-mails par jour et ajoute la mention « Sent with Brevo » ; ces
conditions peuvent changer et ne garantissent pas la réception à Madagascar.
Consulter les [limites officielles](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
et tester la livraison avant une bêta élargie.

Avant d’activer l’envoi, créer un compte Brevo et valider l’adresse expéditeur.
Pour une délivrabilité fiable, utiliser un domaine contrôlé et configurer son
authentification DNS selon la
[documentation Brevo](https://developers.brevo.com/docs/domain-creation-and-management.md).
Une boîte personnelle peut être vérifiée sans domaine, mais l’adresse
d’expéditeur peut être remplacée ou les messages filtrés/rejetés ; cette option
n’est acceptable que pour une bêta interne avec ces risques.

Renseigner `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` et, facultativement,
`BREVO_SENDER_NAME` uniquement dans l’environnement serveur. La clé ne doit
jamais être ajoutée à `VITE_*` ni au client. L’envoi réel exige aussi
`EMAIL_DELIVERY_ENABLED=true` ; cette option est désactivée par défaut. Sans
cette activation, le code reste simulé et affiché dans l’interface. Ne jamais
activer le vrai envoi sans expéditeur vérifié.

Les codes expirent après cinq minutes, sont stockés sous forme de HMAC dans la
base et limités à trois envois par adresse sur une heure. En production, la
réponse API ne révèle pas le code. L’envoi et la délivrabilité à Madagascar ne
sont pas vérifiés tant qu’une adresse expéditeur et une clé de fournisseur ne
sont pas configurées ; les tests n’envoient aucun e-mail réel.
Brevo traite l’adresse destinataire et le code : cette transmission devra être
décrite dans la politique de confidentialité et validée au regard des règles
malgaches sur les transferts de données avant tout lancement public.

Pour le développement local, laisser `VITE_API_BASE_URL` vide : Vite utilise
son proxy local. Pour une compilation web ou Android avec une API distante,
définir cette variable sur l’origine HTTPS de l’API (par exemple
`https://api.example.com`, sans chemin). Cette valeur est intégrée au client ;
n’y placer aucun secret. Les requêtes HTTP, les connexions temps réel et les
photos servies par l’API utilisent cette même origine.

## Hébergement gratuit de bêta

`render.yaml` prépare un service API Fastify gratuit sur Render, avec le port
fourni par l’hébergeur, une écoute réseau accessible, une sonde de santé et un
secret JWT généré. Il attend les variables `DATABASE_URL`, `CLIENT_ORIGIN`,
`BREVO_API_KEY` et `BREVO_SENDER_EMAIL` dans le tableau de bord Render. Ne
copie jamais de clé publiée ou révoquée dans ces réglages. L’envoi OTP reste
désactivé par défaut (`EMAIL_DELIVERY_ENABLED=false`) tant que le nouvel
identifiant n’a pas été vérifié.

Pour le client, connecter le dépôt à Cloudflare Pages avec la commande de build
`npm ci && npm run build` et le répertoire de sortie `client/dist`. Définir
`VITE_API_BASE_URL` avec l’origine HTTPS fournie par Render. Une fois l’adresse
`*.pages.dev` créée, reporter cette origine exacte dans `CLIENT_ORIGIN` côté
Render pour autoriser le navigateur à appeler l’API. Ne placer aucune clé ni URL
de base de données dans `VITE_*`.

Cette architecture est réservée à une bêta sans garantie de disponibilité :
Render Free met le serveur en veille après une période d’inactivité, Neon Free
met la base en veille, et le disque de l’instance Render est éphémère. Les
photos de profil stockées sur ce disque peuvent disparaître après un
redémarrage ; les connexions WebSocket doivent se rétablir après une veille.
Ne l’utilise pas pour des courses réelles ou des données sensibles avant
d’avoir ajouté un stockage durable pour les photos, testé les reconnexions et
validé les obligations de confidentialité et de transfert de données.

Liaison GitHub/Cloudflare/Render et mise en ligne demandent des comptes
fournisseurs. Aucun service n’est déployé automatiquement par ce dépôt. Le
forfait gratuit et ses quotas peuvent changer ; il faut vérifier l’écran de
facturation de chaque fournisseur avant de confirmer une action.

## Application Android de test

Le client web peut être emballé avec Capacitor dans une application Android.
Après avoir déployé l’API et défini son origine HTTPS dans `VITE_API_BASE_URL`
du fichier `.env`, générer le projet Android une seule fois avec
`npx cap add android`, puis lancer `npm run android:apk`. Le script vérifie
l’origine de l’API, compile les ressources web et tente de produire un APK de
débogage dans `android/app/build/outputs/apk/debug/app-debug.apk`.

La compilation native exige Android Studio ou un Android SDK/Gradle compatible
installé et configuré sur la machine. L’APK de débogage est destiné au test
direct sur appareil, pas à une publication Play Store; la publication Play
Store coûte des frais de compte et n’est pas comprise dans l’option gratuite.
Le client embarqué contient l’URL publique de l’API, jamais ses secrets.

## Connexion locale

Sur l’écran d’accueil, choisir **Connexion** ou **Inscription**.

- **Connexion** : saisir son nom ou son adresse e-mail et son mot de passe.
  Si plusieurs comptes portent le même nom, utilisez l’adresse e-mail.
- **Inscription** : saisir son nom, son adresse e-mail, son téléphone, son
  rôle et un mot de passe d’au moins 10 caractères, puis confirmer l’adresse
  avec un code simulé affiché dans l’interface locale ; aucun e-mail n’est envoyé.
  Un envoi réel est possible uniquement si Brevo est configuré et
  `EMAIL_DELIVERY_ENABLED=true`.
  Les rôles Passager et Chauffeur se choisissent avec des boutons illustrés.
  Pour un compte chauffeur, choisir aussi le véhicule (moto ou voiture) parmi
  des boutons illustrés et renseigner son numéro matricule. Une photo de profil
  peut être ajoutée ; elle est redimensionnée dans le navigateur et conservée localement dans
  `server/data/profile-photos/`. Le numéro matricule doit être unique.
  L’inscription nécessite aussi l’acceptation des conditions d’utilisation et
  de la politique de confidentialité, consultables depuis le formulaire. La
  version (`2026-11-05`) et la date d’acceptation sont enregistrées avec le
  compte. Ces textes décrivent le prototype local et devront être revus avant
  une mise en service publique.

Les mots de passe sont stockés sous forme de dérivés scrypt salés, jamais en
clair. Les codes expirent après cinq minutes ou cinq tentatives et ne sont
utilisables qu’une seule fois. La session JWT est conservée localement pendant
sept jours.

Comptes de démonstration :

Mot de passe commun : `DriveNight2026!`

| Rôle | Nom de connexion | Téléphone |
| --- | --- | --- |
| Passager | `Miora Rakoto` | `+261340000001` |
| Chauffeur | `Tiana Rasoanaivo` | `+261340000011` |
| Administrateur | `Admin DriveNight` | `+261340000099` |

Une adresse e-mail et un téléphone encore associés à aucun compte permettent
de créer un compte après confirmation de l’e-mail. L’API fournit le profil
authentifié via `GET /api/me`. Aucun SMS n’est envoyé. Sans configuration
Brevo et activation explicite de l’envoi, les demandes renvoient une erreur de
configuration au lieu d’exposer un code.

## Administration locale

Avec le compte administrateur de démonstration, le tableau de bord présente
les comptes, les demandes ouvertes, la présence, l’historique des courses et
les avis. L’administrateur peut rechercher et filtrer les comptes passager et
chauffeur, les désactiver ou les réactiver, modifier son nom et sa photo, et
changer son mot de passe après vérification de l’ancien. Le rôle
administrateur ne peut pas être modifié depuis le profil. La vue
Administrateurs permet de créer d’autres comptes admin avec nom, téléphone,
mot de passe et adresse e-mail facultative.

La présence des passagers est actualisée toutes les 30 secondes lorsque
l’interface est visible et expire après 90 secondes sans signal. Pour les
chauffeurs, le tableau distingue ceux qui sont en ligne et ceux qui sont déjà
engagés dans une course. Un compte chauffeur peut utiliser l’application dès
son inscription, sans approbation manuelle.

Seul un administrateur authentifié peut utiliser `GET /api/admin/summary`,
`GET /api/admin/operations`, `GET /api/admin/accounts`,
`POST /api/admin/accounts` et `PATCH /api/admin/accounts/:accountId/status`.
La désactivation d’un passager annule ses demandes encore ouvertes ; celle
d’un chauffeur le met hors ligne et retire ses offres en attente. Un compte ne
peut pas être désactivé pendant une course confirmée ou en cours. La
réactivation ne remet pas automatiquement un chauffeur en ligne. Ces outils ne
gèrent ni paiement ni données de gains.

## Espace chauffeur

Après son inscription, le chauffeur peut passer en ligne ou hors ligne,
consulter les demandes compatibles avec son véhicule actif et accepter
directement le prix proposé par le passager ou faire une contre-offre. Le nom,
la photo, l’adresse e-mail et le mot de passe se gèrent
depuis l’écran du profil. Chaque compte chauffeur possède un seul véhicule
(moto ou voiture) ; l’espace chauffeur ne permet pas d’en ajouter un second.
Le changement d’e-mail demande une confirmation OTP simulée en local. Les nouvelles
demandes compatibles sont envoyées immédiatement à tous les chauffeurs en ligne,
sans priorité ni filtrage par proximité.

## Demande passager

Après connexion avec le compte passager, recherchez le départ et la destination
autour d’Antananarivo ou choisissez les points directement sur la carte. La
recherche utilise Nominatim, avec un cache local en mémoire et au plus une
requête externe par seconde. Les recherches sont limitées à Antananarivo et
envoyées au service public d’OpenStreetMap ; aucune clé ni aucun compte ne sont
nécessaires. Les tuiles de carte viennent également d’OpenStreetMap.
Le profil passager s’ouvre depuis son nom dans l’en-tête ; il permet de modifier
le nom, la photo, l’adresse e-mail (avec OTP simulé) et le mot de passe sans
quitter le formulaire de trajet.

La distance affichée est une estimation en ligne droite, pas une distance
routière. Le passager fixe librement le prix proposé et le chauffeur peut
l’accepter ou soumettre son propre montant ; aucun tarif conseillé ou plafond
commercial n’est imposé.

## Offres et temps réel

Après publication d’une demande, les propositions des chauffeurs compatibles
s’affichent au passager avec leur prix, profil, note et véhicule. Le passager
peut accepter une contre-offre pour confirmer la course, ou la refuser sans
fermer sa demande afin d’attendre d’autres propositions. Le prix convenu est
enregistré et les autres offres en attente sont refusées. Le règlement reste
direct, hors de l’application.

Lorsqu’un chauffeur accepte directement le prix du passager, celui-ci dispose
de 15 secondes pour confirmer ou refuser. Une animation indique le temps restant
sans afficher de décompte chiffré. Si le délai expire, la demande reprend sa
recherche de chauffeurs.

Le passager peut annuler sa demande ou sa course jusqu’au début du trajet,
y compris pendant la recherche, la négociation ou lorsque le chauffeur est en
route/arrivé. Une course déjà démarrée ne peut plus être annulée depuis
l’application.

Les nouveaux échanges d’offres et la confirmation sont signalés par
WebSocket. La connexion utilise un ticket temporaire à usage unique, obtenu
avec `POST /api/realtime/ticket` et valable 30 secondes ; le serveur n’accepte
pas le JWT de session dans l’URL. Les abonnements sont limités aux personnes
autorisées pour la course. Les interfaces gardent aussi un rafraîchissement
périodique de secours.

Le composant « Historique des courses » est disponible dans les espaces
passager et chauffeur. `GET /api/rides/history` renvoie les courses du compte
connecté dans l’ordre de leur activité la plus récente, avec le statut, le
trajet, le prix convenu et uniquement le nom/photo du participant associé.
L’historique se charge à la demande et peut être actualisé depuis l’interface.
Après une course terminée, chaque participant peut noter l’autre de 1 à 5
étoiles et ajouter un commentaire facultatif. Un seul avis est accepté par
participant et par course ; la note moyenne du profil est recalculée par le
serveur et réutilisée dans les profils publics et les offres.

Après confirmation, le passager et le chauffeur échangent des messages dans
leur espace de course. `GET /api/rides/:rideId/messages` renvoie l’historique
chronologique et `POST /api/rides/:rideId/messages` enregistre un message
texte de 1 à 2 000 caractères. Seuls le passager et le chauffeur affecté à la
course peuvent lire ou envoyer ces messages ; les nouveaux messages sont
diffusés par l’événement WebSocket `message.created`, sans exposer de numéro
de téléphone. Le chauffeur retrouve ses courses confirmées même s’il passe
hors ligne ; l’envoi de messages reste limité aux trajets actifs.

Le chauffeur fait progresser une course confirmée avec
`PATCH /api/rides/:rideId/status` (`driver_arrived`, `in_progress`, puis
`completed`) ; seules les transitions successives sont acceptées. Pour le
suivi en direct, il active explicitement le partage GPS depuis son espace.
`POST /api/rides/:rideId/location` conserve uniquement la dernière position
pendant la course et la transmet aux deux participants avec
`ride.location.updated`. Les coordonnées sont supprimées à la fin de la
course ; les positions ne sont jamais exposées aux autres chauffeurs.
Son tableau de bord affiche aussi le nombre de courses terminées aujourd’hui
et cette semaine, calculé selon l’heure d’Antananarivo.

L’application et l’API sont préparées pour le choix ultérieur d’un hébergement
PostgreSQL, mais restent à déployer. Aucun paiement n’est configuré.

## Vérifications

```sh
npm test
npm run build
```

Les tests couvrent aussi la disponibilité et les demandes compatibles côté
chauffeur, la création et l’acceptation des offres, l’autorisation des
abonnements WebSocket, l’usage unique des tickets temporaires et la diffusion
des changements d’offres, de statut, de position et de messages aux
participants, ainsi que l’accès restreint à l’historique du chat et au partage
de position et la soumission des évaluations de course. Les tests
d’administration couvrent aussi les permissions, la présence, la consultation
des opérations, la gestion des comptes, la désactivation et la création
d’autres administrateurs.

## Structure

- `client/` — Vite, Svelte et configuration PWA
- `server/` — Fastify, persistance SQLite/PostgreSQL, migrations et seed local,
  photos de profil locales
- `scripts/dev.mjs` — lance les deux workspaces avec `npm run dev`
