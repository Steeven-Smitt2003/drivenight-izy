# Configurer l’OTP e-mail Supabase pour la bêta interne

Recherche effectuée le 8 novembre 2026, à partir de la documentation officielle Supabase. Cette note décrit les réglages du Dashboard, les limites du fournisseur intégré et le parcours local ; la configuration distante actuelle est consignée à la fin.

## Étape manuelle dans le Dashboard hébergé

1. Dans le projet Supabase, ouvrir **Authentication → Sign In / Providers → Email** (page [Sign In / Providers](https://supabase.com/dashboard/project/_/auth/providers)). Vérifier que le fournisseur e-mail est activé et laisser **Confirm email activé**. Les méthodes e-mail sont activées par défaut. Ne pas désactiver la confirmation : cela permettrait de créer un compte avec une adresse qui n’appartient pas à la personne et désactive la limite d’envoi horaire du service intégré. [Test auth flows](https://supabase.com/docs/guides/auth/testing-auth-flows) · [Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless)
2. Ouvrir **Authentication → Email Templates**. Pour le parcours de `signInWithOtp`, utiliser `{{ .Token }}` dans **Confirm sign up** pour les nouveaux comptes et dans **Magic Link or OTP** pour les comptes existants ; les deux doivent remettre le code à six chiffres au formulaire DriveNight. En mode local, ces modèles sont configurés par `auth.email.template.confirmation` et `auth.email.template.magic_link` dans `supabase/config.toml`. [Modèles e-mail](https://supabase.com/docs/guides/auth/auth-email-templates) · [Modèles locaux](https://supabase.com/docs/guides/local-development/customizing-email-templates#available-authentication-email-templates) · [OTP e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp)
3. Garder l’expiration OTP à sa valeur par défaut d’**une heure** et le délai de renvoi par adresse à **60 secondes** pour le test initial. Le réglage d’expiration se trouve dans **Authentication → Sign In / Providers → Auth Providers → Email → Email OTP expiration** ; il s’applique aussi aux liens de confirmation, de récupération et autres liens e-mail. [OTP e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp) · [Limites Auth](https://supabase.com/docs/guides/auth/rate-limits)
4. Pour ce parcours e-mail seulement, aucun fournisseur SMS n’est nécessaire. Le numéro de téléphone conservé dans le profil n’implique pas d’activer l’authentification Phone ; ne configurer aucun fournisseur SMS pour cette étape.

## Limites du fournisseur e-mail intégré (Free)

Tant qu’aucun SMTP personnalisé ni hook d’envoi n’est configuré, le service e-mail intégré Supabase est un service d’essai, non destiné à la production :

- Il n’envoie qu’aux adresses des membres de l’équipe de l’organisation du projet ; les autres adresses échouent avec `email_address_not_authorized`.
- Le quota actuel est de **2 e-mails par heure pour tout le projet** lorsque **Confirm email** est activé. Au dépassement, l’Auth renvoie `429` / `over_email_send_rate_limit`. Supabase indique que cette limite peut évoluer sans préavis.
- Une adresse ne peut demander un nouvel OTP qu’après **60 secondes**. C’est une limite distincte du quota global de deux e-mails par heure.
- La livraison et la disponibilité sont au mieux (« best effort »), sans SLA.

Sources : [Test auth flows](https://supabase.com/docs/guides/auth/testing-auth-flows) · [SMTP personnalisé et limites du fournisseur intégré](https://supabase.com/docs/guides/auth/auth-smtp) · [Limites Auth](https://supabase.com/docs/guides/auth/rate-limits).

**Conséquence pour cette bêta :** un essai sur projet hébergé n’est possible qu’avec une adresse de test déjà membre de l’équipe, et il faut économiser les envois. Ne pas désactiver la confirmation pour contourner ce plafond. Aucun SMTP, fournisseur payant ou déploiement n’est requis pour tester localement.

## Parcours local recommandé

Pour tester inscriptions et connexions sans envoyer de vrais courriels ni consommer le quota hébergé, utiliser le stack local Supabase CLI et Mailpit :

1. Démarrer le stack avec `npm run supabase:start` (équivalent à `npx supabase start`).
2. Dans un autre terminal, lancer `npm run dev:supabase-local`. Le script récupère l’URL et la clé publiable locales depuis la CLI et les transmet au client en mémoire ; il ne modifie pas `.env` et ne reprend pas les identifiants hébergés.
3. Demander un OTP dans l’application, puis ouvrir le message dans Mailpit et saisir le code. En local, les e-mails sont capturés sur la machine, aucun e-mail n’est expédié et il n’y a pas de quota horaire ; la fréquence locale par adresse est d’un e-mail par seconde par défaut.
4. Le projet DriveNight active explicitement la confirmation dans `supabase/config.toml`. Les modèles locaux `confirmation` et `magic_link` affichent `{{ .Token }}`. Le lien affiché par Mailpit est `http://127.0.0.1:54324`.
5. Arrêter les conteneurs avec `npm run supabase:stop`.

Source et étapes détaillées : [Test auth flows](https://supabase.com/docs/guides/auth/testing-auth-flows). Pour les URLs de redirection d’un parcours utilisant un lien, voir [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## Comportement attendu de `verifyOtp`

Le parcours OTP par saisie de code utilise `signInWithOtp({ email })`, puis `verifyOtp({ email, token, type: 'email' })`. Le code est celui reçu par e-mail ; `type: 'email'` est la valeur documentée pour vérifier un OTP saisi et créer la session. En cas de succès, Supabase renvoie une session et l’utilisateur est connecté. Un envoi réussi ne renvoie pas encore de session (`user` et `session` sont nuls) : l’application doit attendre la saisie et la vérification du code. [Guide OTP e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp) · [Référence JavaScript `verifyOtp`](https://supabase.com/docs/reference/javascript/auth-verifyotp)

`signInWithOtp` crée automatiquement un compte si l’adresse n’est pas encore inscrite, sauf si `shouldCreateUser: false` est explicitement passé. Pour le parcours d’inscription/connexion annoncé, garder en tête cette création automatique ; la confirmation activée permet de prouver le contrôle de l’adresse avant la session. [Guide OTP e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp)

### Sources Supabase

- [Passwordless email sign-in / OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Test auth flows](https://supabase.com/docs/guides/auth/testing-auth-flows)
- [Send emails with custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Référence JavaScript `verifyOtp`](https://supabase.com/docs/reference/javascript/auth-verifyotp)

## État vérifié de DriveNight — 8 novembre 2026

- Dans le projet hébergé, l’inscription par e-mail est activée, la confirmation d’adresse est activée et le fournisseur téléphone reste désactivé.
- La longueur OTP e-mail a été réglée à **6 chiffres** pour correspondre au champ de saisie de l’application ; l’expiration reste à **3 600 secondes**.
- Le modèle « Magic Link or OTP » n’est pas éditable tant qu’aucun SMTP personnalisé n’est configuré. Le test d’OTP sur le projet hébergé n’a donc pas été lancé ; aucun e-mail réel n’a été envoyé et aucun fournisseur SMTP/SMS n’a été ajouté.
- `supabase/config.toml` utilise `site_url = "http://localhost:5173"`, `auth.email.enabled = true`, `enable_confirmations = true` et des modèles locaux à code OTP. Les fichiers `supabase/templates/confirmation.html` et `supabase/templates/magic_link.html` contiennent `{{ .Token }}`.
- Le stack Supabase local (PostgreSQL, Auth, REST, Studio et Mailpit) fonctionne sous Docker Desktop ; la migration DriveNight s’y est appliquée.
- Un parcours complet a été vérifié dans l’application web locale : création d’un compte passager, capture du code dans Mailpit, saisie du code, ouverture de session et accès au tableau de bord. Un contrôle API séparé a aussi confirmé la lecture du profil par le JWT utilisateur via RLS. Aucun e-mail réel n’a été envoyé.
- Le client local est accessible sur `http://127.0.0.1:5173`, Mailpit sur `http://127.0.0.1:54324`. Le script `scripts/dev-supabase-local.mjs` permet de relancer uniquement le client avec les identifiants locaux temporaires ; `.env` reste réservé à la configuration hébergée.

**Suite sans frais :** poursuivre les essais en gardant Docker Desktop et Mailpit locaux ; ne configurer aucun SMTP ni fournisseur SMS tant que cela n’est pas explicitement décidé.
