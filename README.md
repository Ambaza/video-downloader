# 🎬 All File Downloader

Coller un lien, récupérer le fichier. Trois moteurs derrière une seule barre de saisie :

| Vous collez… | Moteur | Ce qui se passe |
|---|---|---|
| une page vidéo (YouTube, Vimeo, X, TikTok…) | [yt-dlp](https://github.com/yt-dlp/yt-dlp) | extraction du flux, choix de la qualité |
| un **lien magnet** ou un `.torrent` | [aria2](https://aria2.github.io/) | phase métadonnées, choix des fichiers, téléchargement P2P |
| un **fichier direct** (`.zip`, `.iso`, `.pdf`…) | aria2 | téléchargement multi-connexion |

L'aiguillage est automatique : si yt-dlp ne reconnaît pas le site, le lien part vers aria2 comme fichier direct.

## Prerequisites

Before running the app, make sure you have the following installed:

| Tool | Purpose | Install |
|------|---------|---------|
| **Node.js** (v18+) | Runs the server | [nodejs.org](https://nodejs.org/) |
| **yt-dlp** | Downloads videos | `pip install yt-dlp` or grab the [latest release](https://github.com/yt-dlp/yt-dlp/releases) |
| **curl_cffi** *(recommandé)* | Impersonation TLS — contourne les blocages 410/403 | `pip install -U "yt-dlp[default]" curl_cffi` |
| **aria2** *(pour magnets/torrents)* | Moteur BitTorrent + fichiers directs | **déjà fourni** dans `bin/aria2c.exe` — rien à installer. Voir `bin/README.txt` pour l'origine et les empreintes. |
| **ffmpeg** *(optional)* | Merges video + audio streams | [ffmpeg.org](https://ffmpeg.org/download.html) |

> **Note:** The app auto-detects `yt-dlp` from your PATH, Python Scripts folder, or a local `bin/` directory.

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Launch the app

```bash
npm start
```

Or equivalently:

```bash
npm run dev
```

### 3. Open in your browser

Navigate to **[http://localhost:3000](http://localhost:3000)** — the app is ready to use.

## How It Works

1. Paste a video URL (YouTube, Twitter/X, and [1000+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md))
2. The app fetches available formats and quality options
3. Pick a preset (Best, 1080p, 720p, Audio Only, etc.) or a specific format
4. Hit **Download** — progress is streamed in real time

Downloaded files are saved to:

```
%USERPROFILE%\Downloads\VideoDownloader\
```

## Liens magnet et torrents

Collez le magnet dans la barre de saisie. L'application affiche d'abord la
**liste des fichiers** du torrent, avec leur taille et des cases à cocher :
rien n'est téléchargé tant que vous n'avez pas validé.

### Ce qu'il faut savoir

**La phase « métadonnées » prend quelques secondes.** Un magnet ne contient pas
la liste des fichiers, seulement l'empreinte du contenu (`btih`). L'application
doit d'abord trouver des pairs et leur demander les métadonnées. S'il n'y a
aucune source active, l'opération expire au bout de 90 s avec un message clair.

**Désélectionner un fichier ne l'exclut pas totalement.** Les morceaux
BitTorrent chevauchent les frontières entre fichiers : un fichier écarté peut
quand même être reçu en partie, là où il partage un morceau avec un fichier
voulu. L'application supprime ces résidus une fois le téléchargement terminé —
seuls les fichiers cochés restent sur le disque.

**Le partage est coupé par défaut.** Un client BitTorrent continue normalement à
*redistribuer* le contenu après réception. Ici le partage s'arrête dès la fin,
sauf si vous l'activez dans **Réglages → Moteur torrent**. Activé, votre machine
redistribue le contenu aux autres pairs tant que l'application tourne.

**Votre adresse IP est visible.** Sur BitTorrent, tous les pairs de l'essaim la
voient et les traqueurs l'enregistrent. C'est une différence de nature avec un
téléchargement HTTP classique, et l'interface le rappelle avant chaque torrent.

### Tous les types de fichiers

Au bout d'un magnet on trouve de tout. La liste classe chaque fichier par
famille — **vidéo, audio, images, documents, archives, images disque,
programmes, sous-titres, données** — avec une pastille d'extension colorée et
des filtres par famille.

Concrètement, pour ne récupérer que les PDF d'un torrent qui contient
quatre-vingts fichiers : cliquez sur **Aucun**, puis sur la puce **Documents**,
puis sur **Tout**. Les boutons Tout / Aucun agissent sur la famille affichée, et
la sélection est conservée quand vous changez de filtre.

Si le torrent contient des **programmes exécutables** (`.exe`, `.msi`, `.bat`,
`.apk`…), un bandeau le signale et chaque ligne concernée est marquée. Rien
n'est bloqué : c'est simplement par là que passent les mauvaises surprises.

### Garde-fous

- Le dossier de sortie est verrouillé : les noms de fichiers d'un `.torrent`
  sont choisis par son auteur, tentatives de sortie de dossier comprises. Elles
  sont refusées et signalées en rouge dans la liste.
- L'interface RPC d'aria2 n'écoute que sur `127.0.0.1`, derrière un secret tiré
  au hasard à chaque démarrage.
- Pas de pré-allocation : un torrent de 40 Go ne réserve pas 40 Go avant d'avoir
  reçu le premier octet.
- aria2 est arrêté proprement avec l'application — aucun processus ne reste à
  partager en arrière-plan.

## Cookie Support (for private / age-restricted videos)

Some videos require authentication (login or age verification). The app offers **four cookie modes** in **Settings**:

| Mode | Description |
|------|-------------|
| **Extension navigateur** ⭐ | **La solution définitive.** Une extension lit les cookies via l'API du navigateur (aucun déchiffrement) et les pousse à l'app. Fonctionne **même Chrome/Edge ouverts**, cookies `httpOnly` (login, âge) inclus. Voir `extension/README.md`. |
| **Auto (Navigateur)** | Extracts cookies from a single chosen browser. |
| **Tous les navigateurs + Tor** | At download time, merges cookies from **every installed browser** (Chrome, Edge, Brave, Firefox, Opera, Vivaldi) **and Tor** into one file, via `cookie_merger.py`. Requires Python (installed alongside `pip install yt-dlp`). |
| **Fichier cookies.txt** | Manual upload of an exported `cookies.txt`. |
| **Désactivé** | No cookies sent. |

### ⭐ Solution recommandée : l'extension navigateur

Depuis Chrome 127, aucun outil externe ne peut déchiffrer les cookies Chromium
(App-Bound Encryption). Une **extension** contourne le problème car le navigateur
lui-même donne accès aux cookies. Installez `extension/` (guide dans son README),
choisissez le mode **« Extension navigateur »**, connectez-vous/validez l'âge sur
le site, puis cliquez **Synchroniser**. Robuste, navigateur ouvert, tous sites.

De plus, si l'extraction des cookies échoue pour une raison quelconque,
l'application **réessaie automatiquement le téléchargement sans cookies** — donc un
site qui n'en avait pas besoin (souvent le cas) fonctionne quand même.

### ⚠️ Chrome / Edge / Brave limitation

Since **Chrome 127+**, Chromium browsers use **App-Bound Encryption**: no external tool (yt-dlp included) can decrypt their cookies while the browser is **open**, and often not even when closed. This is a Google security measure against cookie theft — not a bug in this app.

- **Firefox and Tor** can be read **even while open** — prefer them for age-restricted content.
- For Chrome/Edge/Brave, **close the browser** before downloading, or export a `cookies.txt` manually.

### 🧅 Tor

Tor Browser is Firefox-based and its (temporary, in-session) cookies are read from its profile automatically. The app scans common locations (`Desktop`, `Downloads`, `OneDrive\Desktop`, etc.) for `Tor Browser\Browser\TorBrowser\Data\Browser\profile.*`. If your Tor install is elsewhere, set `torProfile` in `settings.json` to the full profile path. Since Tor clears cookies on close, keep it **open** during the download so the session cookies still exist.

### Manual `cookies.txt`

1. Install a browser extension like **Get cookies.txt LOCALLY**
2. Export cookies for the target site
3. Upload the file via the **Settings** panel, or place it as `cookies.txt` in the project root

## Sites qui bloquent yt-dlp (erreur 410 / 403)

Certains sites (**PornHub** et d'autres) renvoient `HTTP Error 410: Gone` ou `403`
à yt-dlp alors que la vidéo s'ouvre parfaitement dans le navigateur. Ce **n'est pas
un problème de cookies** : le site détecte que la requête ne provient pas d'un vrai
navigateur en analysant son **empreinte TLS/HTTP**.

La parade est l'**impersonation** de yt-dlp (`--impersonate`), qui imite l'empreinte
d'un vrai navigateur grâce à `curl_cffi`. L'application l'active **automatiquement**
dès que `curl_cffi` est installé :

```bash
pip install -U "yt-dlp[default]" curl_cffi
```

Redémarrez ensuite l'app. Au démarrage, la ligne `🎭 Impersonation TLS:` indique les
navigateurs imitables détectés (Chrome, Edge, Safari, Firefox). Si elle affiche
`INDISPONIBLE`, installez `curl_cffi`. Vérifiez aussi que la vidéo existe encore :
un vrai `410` en navigateur = contenu réellement supprimé.

## Speed & options

Downloads use `--concurrent-fragments` (default **8**) to fetch fragments of HLS/DASH streams (streaming/anime sites) in parallel — a large speedup versus sequential fetching. Réglable depuis **Réglages → Vitesse** (1–32), ou via `concurrentFragments` dans `settings.json`. The previous `--throttled-rate` flag was removed because it triggered re-extraction loops that slowed some downloads.

Les **Réglages** permettent aussi de :

| Option | Effet |
|--------|-------|
| Anti-blocage (empreinte TLS) | Choisit le navigateur imité, ou désactive l'impersonation. La liste n'affiche que les cibles réellement disponibles. |
| Métadonnées | Écrit titre / auteur / date dans les tags du fichier (ffmpeg requis). |
| Miniature incrustée | Ajoute la miniature en pochette (ffmpeg requis). |
| Sous-titres incrustés | Intègre les sous-titres disponibles (ffmpeg requis). |
| Ignorer les erreurs TLS | À n'activer qu'en dernier recours — voir la section Sécurité. |

Trois téléchargements simultanés au maximum ; au-delà, l'application demande d'attendre.

## Téléchargement par lot (Anime-Sama)

Sur une page de catalogue Anime-Sama, cochez **« Télécharger plusieurs épisodes à
la suite »** puis indiquez une plage (du n° X au n° Y). Les épisodes sont
enchaînés automatiquement ; un épisode en échec est signalé et le lot continue.
Le bouton **Annuler** interrompt le téléchargement en cours et le reste de la file.

## Sécurité

L'application lance des processus et ouvre des fichiers sur votre machine : elle
est donc traitée comme un outil local, jamais comme un service réseau.

- Le serveur n'écoute que sur `127.0.0.1` — il est **injoignable depuis le réseau**
  (Wi-Fi public, LAN). Pour changer de port : `set PORT=3001 && npm start`.
- Les requêtes venant d'une autre origine (une page web quelconque ouverte dans
  votre navigateur) sont **refusées**, tout comme les en-têtes `Host` non locaux
  (protection contre le DNS rebinding). Seule l'extension du navigateur est
  autorisée en plus de l'application elle-même.
- L'ouverture et la suppression de fichiers sont **confinées au dossier de
  téléchargement** : le client n'envoie qu'un nom de fichier, jamais un chemin.
- Les URL et les sélecteurs de format sont validés avant d'atteindre yt-dlp, et
  l'URL est passée après `--` pour qu'elle ne puisse jamais être prise pour une
  option.
- Les fichiers de cookies sont écrits en `0600` (lisibles par vous seul) et
  restent exclus de Git via `.gitignore`.
- La vérification des certificats TLS est **active par défaut**. Elle peut être
  désactivée dans les réglages si un site l'exige, avec l'avertissement associé.

## Project Structure

```
video-downloader/
├── server.js          # Backend Express (API, aiguillage, yt-dlp)
├── aria2.js           # Moteur magnet / torrent / fichier direct (JSON-RPC)
├── cookie_merger.py   # Merges cookies from all browsers + Tor (mode "all")
├── extension/         # Browser extension "Cookie Sync" (definitive cookie fix)
├── public/
│   ├── index.html     # Main HTML page
│   ├── style.css      # Styles
│   └── app.js         # Frontend logic
├── settings.json      # Persisted user settings
├── package.json       # Dependencies & scripts
└── README.md          # ← You are here
```

## Available npm Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start the server (alias) |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `yt-dlp not found` | Install yt-dlp and make sure it's on your PATH |
| Merge fails / no audio | Install **ffmpeg** and add it to your PATH |
| 403 / access denied | Import browser cookies via Settings |
| Rate limited (429) | Wait a few minutes, then retry |
