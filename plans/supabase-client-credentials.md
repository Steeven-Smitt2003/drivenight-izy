# Trouver les identifiants client Supabase

## URL du projet et clé publique

Dans le Dashboard Supabase, ouvrez le dialogue **Connect** du projet : il affiche l’URL du projet et la clé publishable pour le framework choisi. Pour choisir une clé précise ou consulter toutes les clés, ouvrez **Settings > API Keys** ; la documentation précise qu’il n’existe pas de page distincte **Settings > API**. [Documentation officielle Supabase — API keys](https://supabase.com/docs/guides/getting-started/api-keys#find-your-keys)

Pour le client web ou mobile, utilisez la clé **publishable** (`sb_publishable_...`). L’ancienne clé `anon` est son équivalent historique ; la clé publishable peut être exposée dans une application livrée, mais les accès aux données doivent être protégés par les politiques RLS. [Documentation officielle Supabase — API keys](https://supabase.com/docs/guides/getting-started/api-keys#which-key-do-you-use)

Ne confondez pas ces identifiants avec la clé **secret** (`sb_secret_...`) ou l’ancienne `service_role` : elles accordent des privilèges élevés et contournent les politiques RLS. Elles sont réservées au backend et ne doivent jamais être intégrées au client ni à l’APK. [Documentation officielle Supabase — API keys](https://supabase.com/docs/guides/getting-started/api-keys#secret-keys-and-elevated-access)
