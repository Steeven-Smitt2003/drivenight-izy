# Hébergement mobile DriveNight avec Supabase

## Architecture retenue

DriveNight est une application mobile Capacitor : l’APK est compilé et installé séparément. **Supabase fournit le backend de l’application** : PostgreSQL, Auth, Realtime et Storage, avec des Edge Functions pour les opérations serveur. Aucun hébergement Render ni Neon n’est nécessaire dans cette architecture. Cloudflare Pages ne servirait que le client web facultatif, pas l’application Android.

Supabase Edge Functions utilisent un runtime Deno/TypeScript, et non le serveur Fastify/Node tel quel. Le projet actuel implémente dans Fastify ses routes métier, l’authentification JWT, l’OTP e-mail, les WebSockets, les recherches Nominatim et la persistance SQLite/PostgreSQL. Le remplacer entièrement demande donc une migration du code : schéma PostgreSQL, politiques RLS, authentification Supabase, canaux Realtime pour offres/chat/positions, stockage des photos et fonctions serveur pour les opérations qui ne doivent pas être faites avec la clé publique depuis l’application.

La migration est en cours : le dépôt contient une première migration SQL et l’authentification e-mail du client peut utiliser Supabase avec les variables `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY`. Les tableaux de bord, les courses, la négociation, le chat, les positions et l’administration dépendent encore de l’API Fastify ; l’application complète ne peut pas encore fonctionner avec Supabase seul. Ne pas renseigner une URL d’API fictive et ne pas déployer cette migration avant validation des politiques RLS et de tous les parcours.

La clé publique Supabase peut être incluse dans l’application mobile avec des politiques RLS strictes. La clé `service_role` ne doit jamais être intégrée à l’APK ni exposée au client.

## Limites du plan gratuit

Selon la page tarifaire officielle, le plan Free inclut notamment 500 Mo de base de données, 1 Go de stockage de fichiers, 5 Go de transfert, 50 000 utilisateurs actifs mensuels et jusqu’à 2 projets actifs. Les projets gratuits sont mis en pause après une semaine d’inactivité. Ces limites conviennent à un prototype/bêta, mais ne garantissent pas une disponibilité continue ni une capacité suffisante en production.

Supabase Realtime Free affiche une limite de 200 connexions simultanées et 100 messages par seconde. Il faudra gérer les reconnexions et surveiller ces quotas pour le suivi des courses.

**OTP par téléphone :** Supabase exige la configuration d’un fournisseur SMS (par exemple Twilio, MessageBird ou Vonage). Les SMS ont un coût chez le fournisseur ; Supabase Free ne rend pas les SMS gratuits. Pour conserver un parcours sans coût obligatoire, il faut utiliser l’OTP par e-mail ou des numéros de test à code fixe pendant le développement. Le choix du parcours d’authentification doit être confirmé avant de supprimer l’OTP actuellement géré par le backend.

## Distribution de l’APK

La compilation Android produit un APK installable. Une GitHub Release peut distribuer le fichier ; chaque asset doit être inférieur à 2 Gio. Avec le dépôt GitHub privé actuel, seuls les utilisateurs autorisés au dépôt peuvent télécharger la release. L’APK installé se connectera directement au projet Supabase avec son URL et sa clé publique.

## Sources officielles

- Supabase, [Pricing](https://supabase.com/pricing) — quotas Free et pause après une semaine d’inactivité.
- Supabase, [Realtime limits](https://supabase.com/docs/guides/realtime/quotas) — quotas de connexions et messages.
- Supabase, [Edge Functions](https://supabase.com/docs/guides/functions) — runtime Deno/TypeScript et modèle d’exécution.
- Supabase, [Phone sign-in](https://supabase.com/docs/guides/auth/phone-login) — fournisseur SMS requis, coûts d’envoi et numéros de test.
- GitHub, [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) — fichiers de release et taille limite.

## Configuration du code OTP

Dans les réglages Auth du projet Supabase, activer la confirmation d’adresse e-mail et régler le modèle d’e-mail pour inclure `{{ .Token }}` (code à six chiffres), puis tester la réception. Le plan gratuit ne constitue pas un fournisseur de messagerie de production ; prévoir un SMTP vérifié si les limites ou la délivrabilité du service par défaut sont insuffisantes. Le code OTP ne doit jamais être affiché dans l’application.
