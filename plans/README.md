# Plans d’animation DriveNight

| Plan | Titre | Gravité | Statut |
|---|---|---|---|
| 001 | Calmer le focus des champs | MEDIUM | DONE |
| 002 | Ajouter un retour visuel à l’appui | LOW | DONE |
| 003 | Respecter le mouvement réduit | MEDIUM | DONE |
| 004 | Animer les changements d’état du trajet | LOW | DONE |
| 005 | Afficher le délai de confirmation au passager | MEDIUM | DONE |

## Ordre recommandé

1. **001** retire l’animation continue des champs et introduit le jeton
   d’accélération partagé.
2. **002** ajoute un retour tactile cohérent en réutilisant ce jeton.
3. **003** adapte les mouvements décoratifs et retours au clic à la préférence
   de mouvement réduit ; dépend de **002**.
4. **004** anime l’apparition et le retrait des résultats, de l’instruction de
   sélection cartographique et de la confirmation de demande.
5. **005** ajoute un indicateur de progression sans secondes à l’offre chauffeur
   en attente de confirmation du passager.

Les plans sont indépendants du backend et n’ajoutent aucune dépendance.
