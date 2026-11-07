# Extension « Cookie Sync » — Video Downloader

Cette extension résout **définitivement** le problème des cookies (sites nécessitant
une connexion ou une vérification d'âge), y compris sur Chrome/Edge/Brave où le
chiffrement **App-Bound Encryption** empêche yt-dlp de lire les cookies.

Elle lit les cookies via l'API `cookies` du navigateur (comme n'importe quelle
extension), donc **aucun déchiffrement n'est nécessaire** : ça marche navigateur
**ouvert**, et récupère aussi les cookies `httpOnly` (login, session d'âge).

## Installation (Chrome / Edge / Brave / Opera / Vivaldi)

1. Ouvrez `chrome://extensions` (ou `edge://extensions`).
2. Activez le **Mode développeur** (coin supérieur droit).
3. Cliquez **Charger l'extension non empaquetée**.
4. Sélectionnez ce dossier `extension/`.
5. L'icône 🍪 apparaît dans la barre d'outils.

> Firefox : chargez via `about:debugging` → « Ce Firefox » → « Charger un module
> complémentaire temporaire » → sélectionnez `manifest.json`. (Sur Firefox,
> `--cookies-from-browser firefox` fonctionne aussi directement, extension facultative.)

## Utilisation

1. Démarrez l'application (`npm start`, sur http://localhost:3000).
2. Dans l'app, réglages → mode cookies **« Extension navigateur »**.
3. Connectez-vous / validez l'âge sur le site voulu dans votre navigateur.
4. Cliquez l'icône 🍪 → **Synchroniser maintenant** (ou le bouton dans les réglages de l'app).
   - Laissez le champ domaine vide pour envoyer tous les cookies, ou saisissez
     un domaine (ex. `pornhub.com`) pour n'envoyer que les siens.
5. Lancez le téléchargement. Les cookies restent valides ~12 h côté app.

## Confidentialité

Les cookies ne sont envoyés **qu'à votre application locale** (`localhost:3000`),
jamais sur Internet. Le fichier `cookies.synced.txt` reste sur votre PC et est
ignoré par git.
