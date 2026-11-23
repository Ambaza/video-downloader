const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const os = require('os');
const aria2lib = require('./aria2.js');
const trackerslib = require('./trackers.js');
// Remplacée par la liste à jour (ngosang/trackerslist) dès qu'elle est chargée.
let TRACKERS = trackerslib.FALLBACK_TRACKERS;

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
// Sécurité : on n'écoute QUE sur la boucle locale. Sans cela, n'importe quelle
// machine du réseau (Wi-Fi public, LAN d'entreprise) pouvait piloter l'app.
const HOST = process.env.HOST || '127.0.0.1';
const IS_WINDOWS = process.platform === 'win32';

// Downloads directory
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'VideoDownloader');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Track active downloads : downloadId -> { proc, cancelled }
const activeDownloads = new Map();
// Limite de téléchargements simultanés (protège CPU / bande passante / disque)
const MAX_CONCURRENT_DOWNLOADS = 3;
// Durée maximale de recherche des métadonnées d'un magnet (DHT + trackers).
const MAGNET_SEARCH_S = 240;
// Recherche abrégée quand tous les trackers affirment qu'il n'y a aucune source.
const MAGNET_DEAD_S = 90;

// Settings (persisted)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
// Fichier de cookies fusionnés généré automatiquement (mode 'all')
const MERGED_COOKIES_FILE = path.join(__dirname, 'cookies.merged.txt');
// Cookies poussés par l'extension navigateur (contourne App-Bound Encryption)
const SYNCED_COOKIES_FILE = path.join(__dirname, 'cookies.synced.txt');
const COOKIE_MERGER_SCRIPT = path.join(__dirname, 'cookie_merger.py');
// Durée de validité des cookies synchronisés par l'extension.
// 12 h au départ — beaucoup trop court : les cookies de session Google/YouTube
// restent valides des semaines. On les jetait alors qu'ils fonctionnaient encore.
const SYNCED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Taille max acceptée pour un envoi de cookies (anti-DoS mémoire)
const MAX_COOKIE_BODY_BYTES = 8 * 1024 * 1024;

const BROWSER_IDS = ['chrome', 'edge', 'brave', 'firefox', 'opera', 'vivaldi', 'chromium', 'safari'];
const COOKIE_MODES = ['browser', 'all', 'extension', 'file', 'none'];

const DEFAULT_SETTINGS = {
    cookieMode: 'browser',       // 'browser' | 'all' | 'extension' | 'file' | 'none'
    browserChoice: 'chrome',     // navigateur unique pour le mode 'browser'
    concurrentFragments: 8,      // téléchargements de fragments en parallèle (vitesse)
    torProfile: '',              // override manuel du profil Tor (sinon auto-détection)
    impersonate: 'auto',         // 'auto' | 'off' | 'chrome' | 'edge' | ... (empreinte TLS)
    embedSubs: false,            // incruste les sous-titres disponibles
    embedThumbnail: false,       // incruste la miniature comme couverture
    embedMetadata: true,         // titre / auteur / date dans les tags du fichier
    insecureTLS: false,          // --no-check-certificates (désactivé par défaut : c'était un risque)
    lastFormat: 'best',          // dernier format choisi, réutilisé au prochain lancement
    seedAfterDownload: false,    // continuer à PARTAGER le fichier une fois reçu
    btListenPort: 0,             // port d'écoute BitTorrent (0 = laisser aria2 choisir)
};
let settings = { ...DEFAULT_SETTINGS };

try {
    if (fs.existsSync(SETTINGS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        // Migration de l'ancien réglage useCookieFile
        if (saved.useCookieFile !== undefined && saved.cookieMode === undefined) {
            saved.cookieMode = saved.useCookieFile ? 'file' : 'none';
        }
        delete saved.useCookieFile;
        settings = { ...settings, ...saved };
    }
} catch (e) {
    console.warn('⚠️  settings.json illisible, valeurs par défaut utilisées :', e.message);
}

function saveSettings() {
    try {
        const clean = {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = settings[k];
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
    } catch (e) {
        console.error('Impossible d\'enregistrer settings.json :', e.message);
    }
}

// ─── Garde anti-CSRF / anti-DNS-rebinding ────────────────────────
// Le serveur est local, mais n'importe quelle page web ouverte dans le
// navigateur pouvait auparavant déclencher ses endpoints (téléchargements,
// ouverture de fichiers, lecture des réglages). On refuse donc toute requête
// dont l'origine n'est pas l'app elle-même ou l'extension.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isTrustedOrigin(origin) {
    if (!origin) return true; // navigation directe / EventSource même-origine
    if (origin === 'null') return false;
    if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return true;
    try {
        const u = new URL(origin);
        return LOCAL_HOSTS.has(u.hostname);
    } catch { return false; }
}

app.use((req, res, next) => {
    // Host : bloque le DNS rebinding (un domaine qui résout vers 127.0.0.1)
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (host && !LOCAL_HOSTS.has(host)) {
        return res.status(403).json({ error: 'Invalid Host header.' });
    }
    const origin = req.headers.origin;
    if (!isTrustedOrigin(origin)) {
        return res.status(403).json({ error: 'Cross-origin request refused.' });
    }
    if (origin && /^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    // Durcissement de la page servie
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// Les routes de cookies reçoivent du texte brut (Netscape) ou du JSON, quel
// que soit le Content-Type envoyé par l'extension. On les sort donc du parseur
// JSON global — sinon celui-ci consomme le flux et la requête reste pendante.
const RAW_TEXT_ROUTES = new Set(['/api/upload-cookies', '/api/browser-cookies']);
const jsonParser = express.json({ limit: '1mb' });
const textParser = express.text({ type: () => true, limit: MAX_COOKIE_BODY_BYTES });

app.use((req, res, next) => {
    if (RAW_TEXT_ROUTES.has(req.path)) return textParser(req, res, next);
    return jsonParser(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Moteur aria2 : magnet, .torrent et fichiers directs ─────────
const aria2 = new aria2lib.Aria2({
    downloadsDir: DOWNLOADS_DIR,
    onLog: (m) => {
        // Le message IPv6 est du bruit sur les machines sans pile IPv6.
        if (m && !/IPv6 RPC/.test(m)) console.log('  [aria2]', m.slice(0, 200));
    },
});

// Torrents dont les métadonnées sont connues mais que l'utilisateur n'a pas
// encore lancés (en pause, en attente de sa sélection de fichiers).
const pendingTorrents = new Map(); // gid -> { createdAt, name }
const PENDING_TTL_MS = 30 * 60 * 1000;

// Ménage : un torrent laissé en pause finit par être retiré d'aria2, sinon
// chaque magnet collé sans suite resterait indéfiniment en mémoire.
setInterval(() => {
    const now = Date.now();
    for (const [gid, info] of pendingTorrents) {
        if (now - info.createdAt > PENDING_TTL_MS) {
            pendingTorrents.delete(gid);
            aria2.remove(gid).catch(() => { });
        }
    }
}, 5 * 60 * 1000).unref();

// ─── Validation des entrées ──────────────────────────────────────
// Une URL non validée était passée telle quelle à yt-dlp : une valeur comme
// "--exec=calc.exe" aurait été interprétée comme une option, pas comme une URL.
function sanitizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > 2048) return null;
    let u;
    try { u = new URL(value); } catch { return null; }
    if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(u.protocol)) return null;
    return u.toString();
}

// Les sélecteurs de format yt-dlp sont limités à un alphabet sûr, et ne
// peuvent pas commencer par '-' (sinon ils deviendraient une option).
const FORMAT_RE = /^[A-Za-z0-9_+\/\[\]<>=.,:*~?()|-]{1,200}$/;
function sanitizeFormat(raw) {
    if (raw === undefined || raw === null || raw === '') return 'best';
    const value = String(raw).trim();
    if (value.startsWith('-') || !FORMAT_RE.test(value)) return null;
    return value;
}

// Liste d'index de fichiers « 1,3,7 » — bornée au nombre réel de fichiers.
function sanitizeFileSelection(raw, fileCount) {
    if (raw === undefined || raw === null || raw === '') return null; // tout
    const parts = String(raw).split(',').map(x => parseInt(x, 10));
    const ok = parts.filter(n => Number.isInteger(n) && n >= 1 && n <= fileCount);
    if (!ok.length) return null;
    return [...new Set(ok)].sort((a, b) => a - b).join(',');
}

// ─── Find yt-dlp binary ──────────────────────────────────────────
let _ytdlpPath = null;

function getYtDlpPath() {
    if (_ytdlpPath) return _ytdlpPath;

    const exe = IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp';

    const localPath = path.join(__dirname, 'bin', exe);
    if (fs.existsSync(localPath)) { _ytdlpPath = localPath; return _ytdlpPath; }

    const home = os.homedir();
    if (IS_WINDOWS) {
        const pythonVersions = ['Python314', 'Python313', 'Python312', 'Python311', 'Python310', 'Python39'];
        for (const ver of pythonVersions) {
            const candidates = [
                path.join(home, 'AppData', 'Roaming', 'Python', ver, 'Scripts', exe),
                path.join(home, 'AppData', 'Local', 'Programs', 'Python', ver, 'Scripts', exe),
            ];
            for (const p of candidates) {
                if (fs.existsSync(p)) { _ytdlpPath = p; return _ytdlpPath; }
            }
        }
    } else {
        for (const p of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', path.join(home, '.local', 'bin', 'yt-dlp')]) {
            if (fs.existsSync(p)) { _ytdlpPath = p; return _ytdlpPath; }
        }
    }

    _ytdlpPath = 'yt-dlp'; // fallback : PATH
    return _ytdlpPath;
}

// ─── Check if cookies.txt exists ─────────────────────────────────
function hasCookieFile() {
    return fs.existsSync(COOKIES_FILE);
}

// Écrit un fichier de cookies en lecture seule pour le propriétaire (0600).
function writeCookieFile(target, content) {
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch { }
}

// ─── Fresh synced cookies (pushed by the browser extension)? ─────
function hasFreshSyncedCookies() {
    try {
        if (!fs.existsSync(SYNCED_COOKIES_FILE)) return false;
        const age = Date.now() - fs.statSync(SYNCED_COOKIES_FILE).mtimeMs;
        return age < SYNCED_TTL_MS;
    } catch { return false; }
}

// ─── Locate a Python interpreter able to run cookie_merger.py ─────
let _pythonPath = null;
function getPythonPath() {
    if (_pythonPath !== null) return _pythonPath || null;

    // 1) Python associé au yt-dlp installé via pip (…/PythonXX/Scripts/yt-dlp.exe)
    const ytdlp = getYtDlpPath();
    if (ytdlp && ytdlp.toLowerCase().includes('scripts')) {
        const pyDir = path.dirname(path.dirname(ytdlp)); // …/PythonXX
        const candidate = path.join(pyDir, IS_WINDOWS ? 'python.exe' : 'python');
        if (fs.existsSync(candidate)) { _pythonPath = candidate; return _pythonPath; }
    }

    // 2) Interpréteurs sur le PATH
    for (const cmd of IS_WINDOWS ? ['python', 'py', 'python3'] : ['python3', 'python']) {
        try {
            const r = spawnSync(cmd, ['--version'], { windowsHide: true, timeout: 5000 });
            if (r.status === 0 || (r.stdout || r.stderr || '').toString().toLowerCase().includes('python')) {
                _pythonPath = cmd;
                return _pythonPath;
            }
        } catch { }
    }

    _pythonPath = '';
    return null;
}

// ─── Auto-detect Tor Browser profile directories (Firefox-based) ──
function detectTorProfiles() {
    const profiles = [];
    if (settings.torProfile && fs.existsSync(settings.torProfile)) {
        profiles.push(settings.torProfile);
    }

    const home = os.homedir();
    const relative = path.join('Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Browser');
    const baseDirs = [
        path.join(home, 'Desktop'),
        path.join(home, 'Downloads'),
        path.join(home, 'OneDrive', 'Desktop'),
        path.join(home, 'OneDrive', 'Bureau'),
        path.join(home, 'Bureau'),
        home,
        'C:\\Tor Browser',
        path.join(home, 'AppData', 'Local'),
        path.join(home, 'AppData', 'Roaming'),
    ];

    for (const base of baseDirs) {
        const dataBrowser = path.join(base, relative);
        if (!fs.existsSync(dataBrowser)) continue;
        try {
            // Un profil valide contient cookies.sqlite
            for (const entry of fs.readdirSync(dataBrowser)) {
                const profDir = path.join(dataBrowser, entry);
                if (fs.existsSync(path.join(profDir, 'cookies.sqlite'))) {
                    if (!profiles.includes(profDir)) profiles.push(profDir);
                }
            }
        } catch { }
    }
    return profiles;
}

// ─── Detect which standard browsers are installed (profile dirs) ──
function detectInstalledBrowserIds() {
    const home = os.homedir();
    const map = {
        chrome:  path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
        edge:    path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
        brave:   path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
        firefox: path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
        opera:   path.join(home, 'AppData', 'Roaming', 'Opera Software', 'Opera Stable'),
        vivaldi: path.join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
    };
    return Object.keys(map).filter(id => fs.existsSync(map[id]));
}

// ─── Build a merged cookies file from ALL browsers + Tor ─────────
// Cached to avoid re-extracting on every request (extraction is slow).
let _mergedCache = { time: 0, path: null, syncedMtime: 0 };
const MERGED_TTL_MS = 90 * 1000;

function syncedMtime() {
    try { return fs.statSync(SYNCED_COOKIES_FILE).mtimeMs; } catch { return 0; }
}

function invalidateMergedCache() {
    _mergedCache = { time: 0, path: null, syncedMtime: 0 };
}

function buildMergedCookies() {
    // Réutilise le cache si récent, si le fichier existe encore, et si
    // l'extension n'a pas poussé de nouveaux cookies entre-temps.
    if (_mergedCache.path && fs.existsSync(_mergedCache.path)
        && (Date.now() - _mergedCache.time) < MERGED_TTL_MS
        && _mergedCache.syncedMtime === syncedMtime()) {
        return _mergedCache.path;
    }

    const python = getPythonPath();
    if (!python || !fs.existsSync(COOKIE_MERGER_SCRIPT)) {
        return null; // Impossible de fusionner → l'appelant fera un fallback
    }

    const browsers = detectInstalledBrowserIds();
    if (browsers.length === 0) browsers.push('chrome');

    const torProfiles = detectTorProfiles();

    const args = [COOKIE_MERGER_SCRIPT, MERGED_COOKIES_FILE, ...browsers];
    for (const p of torProfiles) { args.push('--tor', p); }

    try {
        const r = spawnSync(python, args, { windowsHide: true, timeout: 60000, encoding: 'utf8' });
        let summary = {};
        try { summary = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { }
        console.log('🍪 Fusion cookies:', JSON.stringify(summary.sources || {}),
                    summary.total ? `(${summary.total} cookies)` : '(aucun)');
        // Ajoute les cookies poussés par l'extension (Chrome/Edge ouverts inclus)
        if (hasFreshSyncedCookies()) {
            try {
                const syncedLines = fs.readFileSync(SYNCED_COOKIES_FILE, 'utf8')
                    .split('\n').filter(l => l && !l.startsWith('#'));
                if (syncedLines.length) {
                    let base = fs.existsSync(MERGED_COOKIES_FILE)
                        ? fs.readFileSync(MERGED_COOKIES_FILE, 'utf8')
                        : '# Netscape HTTP Cookie File\n';
                    if (!base.endsWith('\n')) base += '\n';
                    writeCookieFile(MERGED_COOKIES_FILE, base + syncedLines.join('\n') + '\n');
                    summary.total = (summary.total || 0) + syncedLines.length;
                    (summary.sources = summary.sources || {})['extension'] = syncedLines.length;
                }
            } catch { }
        }

        if (fs.existsSync(MERGED_COOKIES_FILE) && (summary.total || 0) > 0) {
            try { fs.chmodSync(MERGED_COOKIES_FILE, 0o600); } catch { }
            _mergedCache = { time: Date.now(), path: MERGED_COOKIES_FILE, syncedMtime: syncedMtime() };
            return MERGED_COOKIES_FILE;
        }
    } catch (e) {
        console.error('Erreur fusion cookies:', e.message);
    }
    return null;
}

// ─── Return the yt-dlp cookie arguments for the active mode ──────
// noCookies=true → force aucun cookie (utilisé pour la reprise auto).
function getCookieArgs(noCookies = false, forceSynced = false) {
    // Dernier recours : réessayer avec les cookies synchronisés même périmés —
    // mieux vaut un cookie ancien qui marche encore que pas de cookie du tout.
    if (forceSynced && fs.existsSync(SYNCED_COOKIES_FILE)) {
        return ['--cookies', SYNCED_COOKIES_FILE];
    }
    if (noCookies) return [];
    const mode = settings.cookieMode;
    const browser = BROWSER_IDS.includes(settings.browserChoice) ? settings.browserChoice : 'chrome';

    if (mode === 'none') return [];

    // Les cookies de l'extension sont fiables (aucun déchiffrement requis) :
    // on les privilégie dès qu'ils sont frais, sauf en mode 'file'.
    if (mode === 'extension') {
        if (hasFreshSyncedCookies()) return ['--cookies', SYNCED_COOKIES_FILE];
        const merged = buildMergedCookies();
        if (merged) return ['--cookies', merged];
        return ['--cookies-from-browser', browser];
    }

    if (mode === 'all') {
        const merged = buildMergedCookies(); // inclut déjà le fichier de l'extension
        if (merged) return ['--cookies', merged];
        if (hasFreshSyncedCookies()) return ['--cookies', SYNCED_COOKIES_FILE];
        return ['--cookies-from-browser', browser];
    }

    if (mode === 'browser') {
        // Si l'extension a synchronisé récemment, on l'utilise (plus fiable)
        if (hasFreshSyncedCookies()) return ['--cookies', SYNCED_COOKIES_FILE];
        return ['--cookies-from-browser', browser];
    }

    if (mode === 'file' && hasCookieFile()) {
        return ['--cookies', COOKIES_FILE];
    }
    return [];
}

// ─── TLS impersonation (curl_cffi) — corrige les blocages 410/403 ─
// Certains sites renvoient 410/403 à yt-dlp car ils détectent que la requête
// ne vient pas d'un vrai navigateur (empreinte TLS/HTTP).
let _impersonateTargets = null; // null = pas encore détecté
function getImpersonateTargets() {
    if (_impersonateTargets !== null) return _impersonateTargets;
    _impersonateTargets = [];
    try {
        const ytdlp = getYtDlpPath();
        const r = spawnSync(ytdlp, ['--list-impersonate-targets'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
        // Seul stdout porte le tableau : stderr contient des avertissements
        // (« your yt-dlp version is older… ») ou une trace Python, dont les mots
        // étaient pris pour des navigateurs (« it », « you », « traceback »…).
        // Une ligne valable a trois colonnes : client, OS, source (curl_cffi…).
        for (const line of (r.stdout || '').split('\n')) {
            const l = line.trim();
            if (!l || /\(unavailable\)/i.test(l)) continue; // cible listée mais curl_cffi absent
            const cols = l.split(/\s{2,}|\t/).filter(Boolean);
            if (cols.length < 3) continue;
            const m = /^([a-z]+)(?:-[\d.]+)?$/i.exec(cols[0]);
            if (!m || /^client$/i.test(cols[0])) continue;
            // yt-dlp accepte la famille seule (« chrome ») : il prend alors sa
            // version la plus récente disponible.
            const family = m[1].toLowerCase();
            if (!_impersonateTargets.includes(family)) _impersonateTargets.push(family);
        }
    } catch { }
    return _impersonateTargets;
}
function impersonateAvailable() { return getImpersonateTargets().length > 0; }
function pickImpersonateTarget() {
    const t = getImpersonateTargets();
    for (const pref of ['chrome', 'edge', 'safari', 'firefox']) {
        if (t.includes(pref)) return pref;
    }
    return t[0] || null;
}

// ─── Stratégies de tentative selon le site ───────────────────────
// Les options « robustesse » (--referer, --user-agent, --impersonate) ont été
// ajoutées pour des sites qui filtrent sur l'empreinte du client. Sur YouTube
// elles sont contre-productives : l'extracteur négocie lui-même un client
// (web, tv, mobile…) et l'URL du média est liée à ce contexte. Forcer un autre
// User-Agent ou un Referer inattendu fait répondre 403 au CDN googlevideo,
// alors même que l'extraction des métadonnées réussit.
const YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;

function isYouTube(url) {
    try { return YT_HOST_RE.test(new URL(url).hostname.toLowerCase()); }
    catch { return false; }
}

// Échelle de reprise : on descend d'un cran à chaque refus du site.
function buildAttempts(url) {
    if (isYouTube(url)) {
        // Un seul client par barreau : groupés, un client en échec faisait
        // abandonner yt-dlp avant d'avoir essayé les suivants.
        const clients = ['web_safari', 'mweb', 'android_vr', 'ios', 'tv', 'web_embedded'];
        return [
            { name: 'client par défaut', noImpersonate: true, noHeaders: true },
            ...clients.map(c => ({
                name: `client ${c}`,
                noImpersonate: true,
                noHeaders: true,
                extractorArgs: `youtube:player_client=${c}`,
            })),
            // Ultime recours : les cookies poussés par l'extension, même anciens.
            { name: 'cookies synchronisés (même anciens)', noImpersonate: true,
              noHeaders: true, forceSynced: true },
        ];
    }
    return [
        { name: 'standard' },
        { name: 'sans imitation de navigateur', noImpersonate: true, noHeaders: true },
    ];
}

// Le site a refusé la requête (par opposition à : vidéo absente, réseau coupé…)
function isBlockedError(stderr) {
    const s = (stderr || '').toLowerCase();
    return s.includes('403') || s.includes('forbidden')
        || s.includes('unable to download video data')
        || s.includes('unable to download api page')
        || s.includes('requested format is not available')
        || s.includes('sign in to confirm')
        || s.includes('failed to extract any player response')
        || s.includes('the page needs to be reloaded')   // client YouTube rejeté
        || s.includes('po token')                        // jeton d'attestation exigé
        || s.includes('no video formats found')
        || s.includes('content is not available on this app');
}

// ─── Build common yt-dlp args for robustness ─────────────────────
function buildRobustArgs(url, extraArgs = [], opts = {}) {
    const attempt = opts.attempt || {};
    // Nombre de fragments téléchargés en parallèle → gros gain de vitesse
    // sur les flux fragmentés (HLS/DASH). Ignoré pour les fichiers HTTP simples.
    let nFrag = parseInt(settings.concurrentFragments, 10);
    if (!Number.isFinite(nFrag)) nFrag = 8;
    nFrag = Math.min(32, Math.max(1, nFrag));

    const args = [
        '--no-playlist',
        '--no-warnings',
        '--concurrent-fragments', String(nFrag),
    ];

    // Impersonation TLS (si curl_cffi dispo et non désactivée) → contourne 410/403
    let impersonating = false;
    if (settings.impersonate !== 'off' && !opts.noImpersonate && !attempt.noImpersonate) {
        const available = getImpersonateTargets();
        let target = null;
        if (settings.impersonate && settings.impersonate !== 'auto') {
            if (available.includes(settings.impersonate)) target = settings.impersonate;
        } else {
            target = pickImpersonateTarget();
        }
        if (target) {
            args.push('--impersonate', target);
            impersonating = true;
        }
    }

    args.push(
        // Résilience réseau
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', 'fragment:exp=1:2:30',
        // NB: --throttled-rate a été retiré : il provoquait des ré-extractions
        // en boucle qui ralentissaient fortement certains téléchargements.
    );

    // Options propres à l'extracteur (ex. choix du client YouTube)
    if (attempt.extractorArgs) args.push('--extractor-args', attempt.extractorArgs);

    // --no-check-certificates désactive toute vérification TLS : c'est une
    // porte ouverte aux interceptions. Désormais opt-in via les réglages.
    if (settings.insecureTLS) args.push('--no-check-certificates');

    // En-têtes manuels : utiles sur les sites qui filtrent le client, nuisibles
    // là où l'extracteur gère lui-même ses en-têtes (voir buildAttempts).
    if (!attempt.noHeaders) {
        args.push('--referer', url);
        // User agent manuel seulement SANS impersonation (sinon conflit d'empreinte :
        // --impersonate définit déjà un UA cohérent avec le TLS du navigateur imité).
        if (!impersonating) {
            args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
        }
    }

    args.push(...extraArgs);

    // Injection des cookies selon le mode actif (browser | all | extension | file | none)
    args.push(...getCookieArgs(opts.noCookies, attempt.forceSynced));

    // '--' termine les options : l'URL ne peut plus être prise pour une option.
    args.push('--', url);
    return args;
}

// Détecte si une erreur yt-dlp provient de l'extraction/déchiffrement des cookies
function isCookieError(stderr) {
    const s = (stderr || '').toLowerCase();
    return s.includes('dpapi') || s.includes('decrypt')
        || s.includes('could not copy') || s.includes('unable to read')
        || (s.includes('cookies') && (s.includes('database') || s.includes('locked') || s.includes('permission')));
}

// Traduit une sortie d'erreur yt-dlp en message lisible.
function humanizeYtDlpError(stderr, fallback) {
    const s = (stderr || '').toLowerCase();
    if (s.includes('410') || s.includes('gone')) {
        return impersonateAvailable()
            ? 'Le site a bloqué la requête (410). Réessayez ; si cela persiste, la vidéo est peut-être supprimée.'
            : 'Ce site bloque yt-dlp par empreinte TLS (erreur 410). Installez curl_cffi :  pip install -U "yt-dlp[default]" curl_cffi';
    }
    if (s.includes('http error 403') || s.includes('forbidden') || s.includes('unable to download video data')) {
        return 'Accès refusé (403) : le site exige une session connectée. Synchronisez vos cookies via l\'extension du navigateur (Réglages → Extension navigateur), puis réessayez.';
    }
    if (s.includes('http error 429') || s.includes('too many')) return 'Trop de requêtes (429). Patientez quelques minutes puis réessayez.';
    if (s.includes('decrypt') || s.includes('dpapi')) return 'Impossible de lire les cookies du navigateur (chiffrement DPAPI). Utilisez l\'extension ou un fichier cookies.txt.';
    if (s.includes('private') || s.includes('login') || s.includes('sign in')) return 'Cette vidéo nécessite une connexion. Synchronisez vos cookies (Réglages).';
    // \b : sans les limites de mot, « page » déclenchait le message « âge ».
    if (/\bage[- ]?(restricted|verification|gate)\b|\bmature\b|confirm your age/.test(s)) {
        return 'Contenu soumis à vérification d\'âge. Synchronisez vos cookies via l\'extension (Réglages).';
    }
    if (s.includes('the page needs to be reloaded') || s.includes('po token') || s.includes('no video formats found')) {
        return 'YouTube exige une session connectée pour ce téléchargement (aucun client accepté sans cookies). Ouvrez cette page dans Chrome/Edge, choisissez « Extension navigateur » dans les Réglages et cliquez sur Synchroniser, puis réessayez.';
    }
    if (s.includes('geo') || s.includes('country') || s.includes('region')) return 'Vidéo géo-restreinte, indisponible dans votre région. Essayez un VPN.';
    if (s.includes('unsupported url') || s.includes('no suitable')) return 'Cette URL / ce site n\'est pas pris en charge par yt-dlp.';
    if (s.includes('not found') || s.includes('404') || s.includes('unavailable')) return 'Vidéo introuvable. Elle a peut-être été supprimée, ou l\'URL est incorrecte.';
    if (s.includes('ffmpeg')) return 'ffmpeg est requis pour fusionner/convertir ce format. Installez-le et ajoutez-le au PATH.';
    if (s.includes('fragment') && s.includes('error')) return 'Erreurs sur les fragments. Essayez une autre qualité ou rafraîchissez l\'URL.';
    if (s.includes('unable to download') || s.includes('giving up')) return 'Échec après plusieurs tentatives. Essayez une autre qualité ou vérifiez l\'URL.';
    const errLines = (stderr || '').trim().split('\n').filter(l => /error/i.test(l));
    if (errLines.length) return errLines[errLines.length - 1].substring(0, 300);
    return fallback;
}

// ─── Anime-Sama Parser ───────────────────────────────────────────
const ANIME_SAMA_HOSTS = new Set(['anime-sama.to', 'www.anime-sama.to', 'anime-sama.fr', 'www.anime-sama.fr']);

function isAnimeSamaUrl(url) {
    try {
        const u = new URL(url);
        return ANIME_SAMA_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.startsWith('/catalogue/');
    } catch { return false; }
}

async function parseAnimeSama(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        let baseUrl = u.toString();
        if (!baseUrl.endsWith('/')) baseUrl += '/';

        const episodesJsUrl = baseUrl + 'episodes.js';
        // Timeout : sans cela une requête pendante bloquait /api/info indéfiniment.
        const response = await fetch(episodesJsUrl, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) return null;

        const content = await response.text();

        // Extract arrays: var eps1 = [...];
        const players = {};
        const regex = /var\s+(eps\w+)\s*=\s*\[([\s\S]*?)\];/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const varName = match[1];
            const linksText = match[2];
            const links = linksText
                .split('\n')
                .map(line => {
                    const l = line.trim();
                    if (!l || l.startsWith('//')) return null;
                    const linkMatch = l.match(/['"](https?:\/\/[^'"]+)['"]/);
                    return linkMatch ? linkMatch[1] : null;
                })
                .filter(Boolean);

            if (links.length > 0) players[varName] = links;
        }

        if (Object.keys(players).length === 0) return null;

        const playerMap = {
            eps1: 'Player 1 (Sibnet/Primary)',
            eps2: 'Player 2 (Vidmoly)',
            eps3: 'Player 3 (Sendvid)',
            eps4: 'Player 4',
            eps5: 'Player 5'
        };

        const formattedPlayers = Object.keys(players).map(key => ({
            id: key,
            name: playerMap[key] || key.toUpperCase(),
            count: players[key].length,
            links: players[key]
        }));

        // Sort by episode count descending to find the main list
        formattedPlayers.sort((a, b) => b.count - a.count);

        return {
            isAnimeSama: true,
            title: baseUrl.split('/').filter(Boolean).pop().replace(/-/g, ' ').toUpperCase(),
            baseUrl,
            players: formattedPlayers,
            maxEpisodes: Math.max(...formattedPlayers.map(p => p.count))
        };
    } catch (e) {
        console.error('Anime-Sama Parse Error:', e.message);
        return null;
    }
}

// Interroge une URL de fichier sans la télécharger (nom, taille, type).
async function probeDirectFile(url) {
    let size = null, type = null, name = null;
    try {
        const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (r.ok) {
            size = Number(r.headers.get('content-length')) || null;
            type = r.headers.get('content-type') || null;
            const cd = r.headers.get('content-disposition') || '';
            const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
            if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
        }
    } catch { }
    if (!name) {
        try { name = path.basename(new URL(url).pathname) || 'fichier'; } catch { name = 'fichier'; }
    }
    return {
        kind: 'file',
        title: name,
        category: aria2lib.fileCategory(name),
        executable: aria2lib.isExecutable(name),
        url,
        totalSize: size,
        totalSizeLabel: size ? aria2lib.formatBytes(size) : 'inconnue',
        mimeType: type,
        presets: [],
    };
}

// ─── GET /api/info — Fetch video metadata ─────────────────────────
app.get('/api/info', async (req, res) => {
    const raw = req.query.url;

    // ── Magnet : rien à interroger, il faut d'abord rejoindre l'essaim ──
    if (aria2lib.isMagnet(raw)) {
        const parsed = aria2lib.sanitizeMagnet(raw);
        if (!parsed) {
            return res.status(400).json({ error: 'Lien magnet invalide (identifiant btih attendu : 40 caractères hexadécimaux ou 32 en base32).' });
        }
        if (!aria2.ready) {
            return res.status(503).json({
                error: aria2.available
                    ? 'Le moteur BitTorrent n\'a pas démarré. Redémarrez l\'application.'
                    : 'aria2 n\'est pas installé — requis pour les liens magnet et les torrents. Voir le README.',
            });
        }
        return analyzeTorrent(res, parsed.magnet, { name: parsed.displayName, infoHash: parsed.infoHash });
    }

    const url = sanitizeUrl(raw);
    if (!url) return res.status(400).json({ error: 'URL invalide (http, https, ftp ou magnet attendu).' });

    // FTP / SFTP : aucun site vidéo derrière, aria2 télécharge directement.
    if (/^s?ftp:/i.test(url)) {
        if (!aria2.ready) return res.status(503).json({ error: 'Moteur de téléchargement indisponible.' });
        return res.json(await probeDirectFile(url));
    }

    // Lien vers un fichier .torrent : même parcours qu'un magnet (liste des
    // fichiers, choix, puis téléchargement), au lieu de tout lancer d'un coup.
    if (/\.torrent$/i.test(new URL(url).pathname)) {
        if (!aria2.ready) return res.status(503).json({ error: 'Moteur BitTorrent indisponible.' });
        return analyzeTorrent(res, url, { name: decodeURIComponent(path.basename(new URL(url).pathname, '.torrent')) });
    }

    return infoFromYtDlp(req, res, url);
});

// Attend qu'une recherche déjà lancée pour ce torrent aboutisse, et renvoie
// l'identifiant du torrent (celui qui porte la liste des fichiers). null si
// la recherche disparaît sans résultat ou si le délai est dépassé.
async function waitForSameTorrent(hashHex, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let missing = 0;
    while (Date.now() < deadline) {
        const st = await aria2.findByInfoHash(hashHex).catch(() => null);
        if (st && st.following) return st.gid;
        missing = st ? 0 : missing + 1;
        if (missing >= 6) return null; // plus rien en cours depuis 3 s
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

// Récupère les métadonnées d'un torrent (magnet ou URL .torrent) mis en pause
// par aria2, et renvoie la liste de ses fichiers.
async function analyzeTorrent(res, uri, { name: fallbackName = '', infoHash = null } = {}) {
        const hash20 = infoHash ? trackerslib.infoHashBytes(infoHash) : null;
        const hashHex = hash20 && hash20.length === 20 ? hash20.toString('hex') : null;
        // En parallèle de la recherche : combien de sources les trackers
        // connaissent-ils ? Sert à dire clairement qu'un document n'existe plus.
        const scrapeP = hashHex ? trackerslib.scrape(hashHex, TRACKERS).catch(() => null) : Promise.resolve(null);
        try {
            let gid = null, metaGid = null;
            const started = Date.now();
            try {
                // Un torrent peu partagé met parfois plusieurs minutes à livrer
                // ses métadonnées : 90 s puis un arrêt d'aria2 à 120 s sans
                // débit abandonnaient des magnets qui auraient fini par répondre.
                metaGid = await aria2.addUri([uri], { 'bt-stop-timeout': String(MAGNET_SEARCH_S + 30) });
            } catch (e) {
                // Magnet recollé alors que sa première recherche n'est pas
                // finie : on attend son résultat et on le réutilise.
                if (!/already registered/i.test(e.message) || !hashHex) throw e;
                gid = await waitForSameTorrent(hashHex, MAGNET_SEARCH_S * 1000);
                if (!gid) {
                    return res.status(504).json({ error: 'Ce magnet est déjà en cours de recherche, sans résultat pour l\'instant. Réessayez dans un moment.' });
                }
            }
            if (!gid) {
                // Si les trackers ne connaissent aucune source (en dehors de
                // nous), inutile d'attendre 4 minutes : un torrent vivant indexé
                // par le DHT y est trouvé en quelques secondes. On abrège à 90 s.
                const ac = new AbortController();
                let fastFail = null;
                scrapeP.then(sc => {
                    if (sc && sc.responded >= 5 && sc.others === 0) {
                        fastFail = setTimeout(() => ac.abort(), Math.max(0, MAGNET_DEAD_S * 1000 - (Date.now() - started)));
                    }
                });
                let failure = null;
                try {
                    gid = await aria2.waitForMetadata(metaGid, { timeoutMs: MAGNET_SEARCH_S * 1000, signal: ac.signal });
                } catch (e) {
                    failure = e;
                } finally {
                    if (fastFail) clearTimeout(fastFail);
                }
                if (failure) {
                    await aria2.remove(metaGid);
                    // aria2 accepte un magnet recollé, puis le fait échouer
                    // (« already registered ») : on rejoint la recherche en cours.
                    if (/already registered/i.test(failure.message) && hashHex) {
                        gid = await waitForSameTorrent(hashHex, MAGNET_SEARCH_S * 1000);
                        if (!gid) {
                            return res.status(504).json({ error: 'Ce magnet est déjà en cours de recherche, sans résultat pour l\'instant. Réessayez dans un moment.' });
                        }
                    } else if (failure.code !== 'SEARCH_STOPPED') {
                        // Seule une recherche arrivée au bout se juge avec les
                        // trackers ; toute autre erreur est rapportée telle quelle.
                        return res.status(502).json({ error: failure.message });
                    } else {
                        const sc = await scrapeP;
                        const waited = Math.max(1, Math.round((Date.now() - started) / 1000));
                        if (sc && sc.responded > 0 && sc.others === 0) {
                            return res.status(404).json({
                                notFound: true,
                                error: `Ce document n'existe plus sur le réseau BitTorrent : aucun des ${sc.responded} trackers interrogés `
                                    + `ne lui connaît de source, et le réseau DHT n'en a trouvé aucune en ${waited} secondes. `
                                    + 'Aucune application ne pourra le télécharger : cherchez un autre lien pour le même contenu.',
                            });
                        }
                        if (sc && sc.others > 0) {
                            return res.status(504).json({
                                error: `Les trackers connaissent ${sc.others} pair(s) pour ce document, mais aucun n'a fourni sa description en ${waited} secondes. `
                                    + 'Ils sont sans doute déconnectés ou derrière des pare-feu : réessayez plus tard.',
                            });
                        }
                        return res.status(504).json({ error: failure.message });
                    }
                }
            }
            const st = await aria2.tellStatus(gid);
            const files = aria2lib.listFiles(st, DOWNLOADS_DIR);
            const name = aria2lib.statusName(st) || fallbackName || infoHash || 'torrent';
            pendingTorrents.set(gid, { createdAt: Date.now(), name });

            return res.json({
                kind: 'torrent',
                gid,
                title: name,
                infoHash: st.infoHash || infoHash,
                totalSize: files.reduce((n, f) => n + f.size, 0),
                totalSizeLabel: aria2lib.formatBytes(files.reduce((n, f) => n + f.size, 0)),
                files,
                // Un .torrent nomme ses fichiers librement, « ../ » compris.
                hasSuspiciousPaths: files.some(f => f.suspicious),
                // Un torrent peut contenir des programmes : c'est par là que
                // passent les mauvaises surprises. On ne bloque pas, on prévient.
                executableCount: files.filter(f => f.executable).length,
                categories: files.reduce((acc, f) => {
                    acc[f.category] = (acc[f.category] || 0) + 1;
                    return acc;
                }, {}),
                presets: [],
            });
        } catch (e) {
            return res.status(500).json({ error: 'Échec de la lecture du torrent : ' + e.message });
        }
}

// Lien http(s) : site vidéo (yt-dlp) ou, à défaut, fichier direct (aria2).
async function infoFromYtDlp(req, res, url) {
    if (isAnimeSamaUrl(url)) {
        const asData = await parseAnimeSama(url);
        if (asData) {
            return res.json({
                title: asData.title,
                thumbnail: 'https://anime-sama.to/template/images/logo.png',
                isAnimeSama: true,
                asData,
                presets: []
            });
        }
    }

    const ytdlp = getYtDlpPath();
    // Empêche la double réponse : 'error' et 'close' peuvent tous deux être
    // émis quand le spawn échoue → ERR_HTTP_HEADERS_SENT auparavant.
    let responded = false;
    const reply = (status, payload) => {
        if (responded) return;
        responded = true;
        res.status(status).json(payload);
    };
    req.on('close', () => { responded = true; });

    const attempts = buildAttempts(url);

    const runInfo = (attemptIdx, noCookies) => {
        const attempt = attempts[attemptIdx];
        const args = buildRobustArgs(url, ['--dump-json'], { noCookies, attempt });
        let output = '';
        let errorOutput = '';

        let proc;
        try {
            proc = spawn(ytdlp, args, { windowsHide: true });
        } catch (err) {
            return reply(500, { error: 'yt-dlp introuvable. Installez-le d\'abord.', details: err.message });
        }

        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 120000);

        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', (data) => {
            errorOutput += data.toString();
            if (errorOutput.length > 200000) errorOutput = errorOutput.slice(-100000);
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            console.error('Spawn error:', err.message);
            reply(500, { error: 'yt-dlp introuvable. Installez-le d\'abord.', details: err.message });
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (responded) return;

            // Reprise auto : l'échec vient de l'extraction des cookies → réessaie sans
            if (code !== 0 && !noCookies && !attempt.forceSynced && isCookieError(errorOutput)) {
                console.warn('⚠️  Échec cookies à l\'info — reprise sans cookies.');
                return runInfo(attemptIdx, true);
            }
            // Le site a refusé la requête → on descend d'un cran dans l'échelle
            if (code !== 0 && attemptIdx + 1 < attempts.length && isBlockedError(errorOutput)) {
                console.warn(`⚠️  Refus du site à l'info — nouvel essai : ${attempts[attemptIdx + 1].name}.`);
                return runInfo(attemptIdx + 1, noCookies);
            }
            if (code !== 0) {
                // yt-dlp ne connaît pas ce site : c'est sans doute un fichier
                // à télécharger tel quel. aria2 s'en charge.
                if (/unsupported url|no suitable/i.test(errorOutput) && aria2.ready) {
                    return probeDirectFile(url).then(info => reply(200, info))
                        .catch(() => reply(500, {
                            error: 'Ni une vidéo reconnue, ni un fichier téléchargeable.',
                            details: errorOutput.substring(0, 300),
                        }));
                }
                console.error('yt-dlp info error:', errorOutput.substring(0, 800));
                return reply(500, {
                    error: humanizeYtDlpError(errorOutput, 'Impossible de récupérer les informations de la vidéo.'),
                    details: errorOutput.substring(0, 500) || 'Erreur inconnue.'
                });
            }

            try {
                const firstJson = output.split('\n').find(l => l.trim().startsWith('{'));
                const info = JSON.parse(firstJson || output);

                const formats = (info.formats || [])
                    .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
                    .map(f => ({
                        format_id: f.format_id,
                        ext: f.ext,
                        resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : 'audio only'),
                        filesize: f.filesize || f.filesize_approx || null,
                        fps: f.fps || null,
                        vcodec: f.vcodec,
                        acodec: f.acodec,
                        tbr: f.tbr || null,
                        format_note: f.format_note || '',
                        hasVideo: f.vcodec !== 'none',
                        hasAudio: f.acodec !== 'none',
                    }));

                const presets = [
                    { id: 'best', label: 'Meilleure qualité', description: 'Vidéo + audio, qualité maximale' },
                    { id: 'bestvideo+bestaudio/best', label: 'Best vidéo + best audio', description: 'Fusion — nécessite ffmpeg' },
                ];

                const resolutions = [2160, 1440, 1080, 720, 480, 360];
                for (const r of resolutions) {
                    if ((info.formats || []).some(f => f.height === r)) {
                        presets.push({
                            id: `bestvideo[height<=${r}]+bestaudio/best[height<=${r}]`,
                            label: `${r}p`,
                            description: `Jusqu'à ${r}p`
                        });
                    }
                }

                presets.push(
                    { id: 'bestaudio/best', label: 'Audio seul', description: 'Piste audio d\'origine' },
                    { id: 'worst', label: 'Qualité minimale', description: 'Fichier le plus léger' },
                );

                reply(200, {
                    title: info.title,
                    thumbnail: info.thumbnail,
                    duration: info.duration,
                    duration_string: info.duration_string,
                    uploader: info.uploader || info.channel || info.uploader_id,
                    view_count: info.view_count,
                    upload_date: info.upload_date,
                    description: (info.description || '').substring(0, 300),
                    webpage_url: info.webpage_url,
                    extractor: info.extractor || info.extractor_key,
                    hasSubtitles: Object.keys(info.subtitles || {}).length > 0,
                    formats,
                    presets
                });
            } catch (e) {
                console.error('Parse error:', e.message);
                reply(500, { error: 'Réponse de yt-dlp illisible.' });
            }
        });
    };

    runInfo(0, false);
}

// ─── Diffusion SSE de la progression d'un téléchargement aria2 ────
function streamAria2(req, res, gid, { label = '' } = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    const send = (event, data) => {
        if (closed) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { }
    };

    activeDownloads.set(gid, { aria2: true, cancelled: false });
    send('start', { downloadId: gid, message: 'Connexion à l\'essaim…' });
    if (label) send('info', { filename: label });

    const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { } } }, 15000);

    const finish = () => {
        clearInterval(heartbeat);
        clearInterval(timer);
        activeDownloads.delete(gid);
        pendingTorrents.delete(gid);
        closed = true;
        try { res.end(); } catch { }
    };

    let lastStatus = '';
    const timer = setInterval(async () => {
        if (closed) return;
        let st;
        try {
            st = await aria2.tellStatus(gid);
        } catch (e) {
            // Le téléchargement a disparu d'aria2 (retiré, ou démon arrêté)
            const entry = activeDownloads.get(gid);
            if (entry && entry.cancelled) { send('cancelled', { message: 'Téléchargement annulé.' }); }
            else { send('error', { message: 'Le moteur de téléchargement ne répond plus.' }); }
            return finish();
        }

        const name = aria2lib.statusName(st);
        if (name && name !== label) { label = name; send('info', { filename: name }); }

        if (st.status !== lastStatus) {
            lastStatus = st.status;
            const labels = {
                waiting: 'En file d\'attente…',
                active: 'Téléchargement en cours…',
                paused: 'En pause.',
            };
            if (labels[st.status]) send('status', { message: labels[st.status] });
        }

        if (st.status === 'active' || st.status === 'waiting') {
            send('progress', aria2lib.mapStatus(st));
            return;
        }
        if (st.status === 'complete') {
            send('progress', aria2lib.mapStatus(st));
            send('complete', {
                message: 'Téléchargement terminé !',
                filename: name || label,
                directory: DOWNLOADS_DIR,
            });
            return finish();
        }
        if (st.status === 'error') {
            send('error', { message: st.errorMessage || `Échec du téléchargement (code ${st.errorCode}).` });
            return finish();
        }
        if (st.status === 'removed') {
            send('cancelled', { message: 'Téléchargement annulé.' });
            return finish();
        }
    }, 700);

    req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(timer);
        const entry = activeDownloads.get(gid);
        if (entry && !entry.keepOnDisconnect) {
            activeDownloads.delete(gid);
            aria2.remove(gid).catch(() => { });
        }
    });
}

// ─── GET /api/download — Download with SSE progress ───────────────
app.get('/api/download', (req, res) => {
    // ── Torrent déjà analysé : on reprend le gid mis en pause ──
    if (req.query.gid) {
        const gid = String(req.query.gid);
        if (!/^[0-9a-f]{16}$/i.test(gid) || !pendingTorrents.has(gid)) {
            return res.status(404).json({ error: 'Torrent introuvable ou expiré. Recollez le lien magnet.' });
        }
        if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
            return res.status(429).json({ error: `Trop de téléchargements simultanés (max ${MAX_CONCURRENT_DOWNLOADS}).` });
        }
        const info = pendingTorrents.get(gid);
        return (async () => {
            try {
                const st = await aria2.tellStatus(gid);
                const count = (st.files || []).length;
                const selection = sanitizeFileSelection(req.query.files, count);
                if (selection) await aria2.changeOption(gid, { 'select-file': selection });
                await aria2.unpause(gid);
            } catch (e) {
                return res.status(500).json({ error: 'Impossible de démarrer le torrent : ' + e.message });
            }
            streamAria2(req, res, gid, { label: info.name });
        })();
    }

    // ── Fichier direct confié à aria2 ──
    if (req.query.direct === '1') {
        const target = sanitizeUrl(req.query.url);
        if (!target) return res.status(400).json({ error: 'URL invalide.' });
        if (!aria2.ready) return res.status(503).json({ error: 'Moteur de téléchargement indisponible.' });
        if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
            return res.status(429).json({ error: `Trop de téléchargements simultanés (max ${MAX_CONCURRENT_DOWNLOADS}).` });
        }
        return aria2.addUri([target], {}).then(gid => {
            streamAria2(req, res, gid, { label: '' });
        }).catch(e => res.status(500).json({ error: 'Échec du démarrage : ' + e.message }));
    }

    const url = sanitizeUrl(req.query.url);
    if (!url) return res.status(400).json({ error: 'URL invalide (http/https attendu).' });

    const format = sanitizeFormat(req.query.format);
    if (format === null) return res.status(400).json({ error: 'Sélecteur de format invalide.' });

    if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        return res.status(429).json({ error: `Trop de téléchargements simultanés (max ${MAX_CONCURRENT_DOWNLOADS}). Attendez qu'un se termine.` });
    }

    // Mémorise le dernier format utilisé (confort)
    if (settings.lastFormat !== format) { settings.lastFormat = format; saveSettings(); }

    const downloadId = randomUUID();
    const audioOnly = /^bestaudio/.test(format);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    const sendEvent = (event, data) => {
        if (closed) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { }
    };
    // Battement de cœur : évite qu'un proxy/antivirus coupe la connexion SSE.
    const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { } } }, 15000);

    const ytdlp = getYtDlpPath();
    const outputTemplate = path.join(DOWNLOADS_DIR, '%(title).150s [%(id)s].%(ext)s');

    const entry = { proc: null, cancelled: false };
    activeDownloads.set(downloadId, entry);
    sendEvent('start', { downloadId, message: 'Démarrage du téléchargement…' });

    let lastFilename = '';
    let stderrBuffer = '';

    const finish = () => {
        clearInterval(heartbeat);
        activeDownloads.delete(downloadId);
        closed = true;
        try { res.end(); } catch { }
    };

    const attempts = buildAttempts(url);

    const runDownload = (attemptIdx, noCookies) => {
        const attempt = attempts[attemptIdx];
        lastFilename = '';
        stderrBuffer = '';

        const extra = [
            '-f', format,
            '-o', outputTemplate,
            '--newline',
            '--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s',
            '--trim-filenames', '150',
        ];
        if (settings.embedMetadata) extra.push('--embed-metadata');
        if (settings.embedThumbnail) extra.push('--embed-thumbnail');
        if (settings.embedSubs && !audioOnly) extra.push('--embed-subs', '--sub-langs', 'all,-live_chat');

        const downloadArgs = buildRobustArgs(url, extra, { noCookies, attempt });

        let proc;
        try {
            proc = spawn(ytdlp, downloadArgs, { windowsHide: true });
        } catch (err) {
            sendEvent('error', { message: `Impossible de lancer yt-dlp : ${err.message}` });
            return finish();
        }
        entry.proc = proc;

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
                if (destMatch) {
                    lastFilename = path.basename(destMatch[1].trim());
                    sendEvent('info', { filename: lastFilename });
                    continue;
                }

                const alreadyMatch = line.match(/\[download\]\s+(.+)\s+has already been downloaded/);
                if (alreadyMatch) {
                    lastFilename = path.basename(alreadyMatch[1].trim());
                    sendEvent('info', { filename: lastFilename });
                    sendEvent('progress', { percent: '100%', speed: '-', eta: '0s', size: '-' });
                    continue;
                }

                if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[Metadata]')) {
                    sendEvent('status', { message: 'Traitement du fichier…' });
                    continue;
                }
                if (line.includes('[FixupM3u8]') || line.includes('[ffmpeg]')) {
                    sendEvent('status', { message: 'Conversion du format…' });
                    continue;
                }
                if (line.includes('[EmbedSubtitle]')) {
                    sendEvent('status', { message: 'Incrustation des sous-titres…' });
                    continue;
                }

                const fragMatch = line.match(/\[download\]\s+Downloading\s+(\d+)\s+fragments?/i);
                if (fragMatch) {
                    sendEvent('status', { message: `Téléchargement de ${fragMatch[1]} fragments…` });
                    continue;
                }

                if (line.includes('Retrying') || line.includes('Got error')) {
                    sendEvent('status', { message: 'Nouvelle tentative…' });
                    continue;
                }

                const parts = line.trim().split('|');
                if (parts.length === 4) {
                    sendEvent('progress', {
                        percent: parts[0].trim(),
                        speed: parts[1].trim(),
                        eta: parts[2].trim(),
                        size: parts[3].trim()
                    });
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            stderrBuffer += msg + '\n';
            if (stderrBuffer.length > 200000) stderrBuffer = stderrBuffer.slice(-100000);
            if (msg && (msg.includes('WARNING') || msg.includes('ERROR'))) {
                sendEvent('warning', { message: msg.substring(0, 200) });
            }
        });

        proc.on('close', (code) => {
            entry.proc = null;

            if (entry.cancelled || closed) {
                sendEvent('cancelled', { message: 'Téléchargement annulé.' });
                return finish();
            }

            // Reprise auto : échec dû aux cookies → réessaie une fois sans
            if (code !== 0 && !noCookies && !attempt.forceSynced && isCookieError(stderrBuffer)) {
                console.warn('⚠️  Échec cookies au téléchargement — reprise sans cookies.');
                sendEvent('status', { message: 'Cookies illisibles — nouvel essai sans cookies…' });
                return runDownload(attemptIdx, true);
            }
            // Le site a refusé la requête → on change la façon de se présenter
            if (code !== 0 && attemptIdx + 1 < attempts.length && isBlockedError(stderrBuffer)) {
                const next = attempts[attemptIdx + 1];
                console.warn(`⚠️  Refus du site — nouvel essai : ${next.name}.`);
                sendEvent('status', { message: `Le site a refusé la requête — nouvel essai (${next.name})…` });
                return runDownload(attemptIdx + 1, noCookies);
            }

            if (code === 0) {
                if (!lastFilename) {
                    try {
                        const files = fs.readdirSync(DOWNLOADS_DIR)
                            .filter(n => !n.endsWith('.part') && !n.endsWith('.ytdl'))
                            .map(name => ({ name, time: fs.statSync(path.join(DOWNLOADS_DIR, name)).mtimeMs }))
                            .sort((a, b) => b.time - a.time);
                        if (files.length > 0) lastFilename = files[0].name;
                    } catch { }
                }
                sendEvent('complete', {
                    message: 'Téléchargement terminé !',
                    filename: lastFilename,
                    directory: DOWNLOADS_DIR
                });
            } else {
                sendEvent('error', {
                    message: humanizeYtDlpError(stderrBuffer, `Échec du téléchargement (code ${code}).`)
                });
            }
            finish();
        });

        proc.on('error', (err) => {
            entry.proc = null;
            sendEvent('error', { message: `Impossible de lancer le téléchargement : ${err.message}` });
            finish();
        });
    };

    runDownload(0, false);

    req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        const e = activeDownloads.get(downloadId);
        if (e) {
            e.cancelled = true;
            if (e.proc) { try { e.proc.kill('SIGTERM'); } catch { } }
            activeDownloads.delete(downloadId);
        }
    });
});

// ─── POST /api/cancel ────────────────────────────────────────────
app.post('/api/cancel', async (req, res) => {
    const { downloadId } = req.body || {};
    const entry = typeof downloadId === 'string' ? activeDownloads.get(downloadId) : null;
    if (entry && entry.aria2) {
        entry.cancelled = true;
        await aria2.remove(downloadId).catch(() => { });
        activeDownloads.delete(downloadId);
        pendingTorrents.delete(downloadId);
        return res.json({ success: true });
    }
    if (entry) {
        entry.cancelled = true;
        if (entry.proc) { try { entry.proc.kill('SIGTERM'); } catch { } }
        // Filet de sécurité : SIGKILL si le processus s'accroche
        setTimeout(() => {
            if (entry.proc) { try { entry.proc.kill('SIGKILL'); } catch { } }
        }, 4000);
        return res.json({ success: true });
    }
    res.json({ success: false, message: 'Téléchargement introuvable.' });
});

// ─── Historique : tout est confiné au dossier de téléchargements ──
// Le chemin absolu n'est plus exposé ni accepté : le client ne manipule
// qu'un nom de fichier, résolu et vérifié côté serveur.
function resolveInDownloads(name) {
    // accepte aussi un dossier (résultat d'un torrent multi-fichiers)
    if (typeof name !== 'string' || !name) return null;
    if (name.includes('\0')) return null;
    const base = path.basename(name);
    if (!base || base === '.' || base === '..') return null;
    const full = path.resolve(DOWNLOADS_DIR, base);
    const root = path.resolve(DOWNLOADS_DIR) + path.sep;
    if (!full.startsWith(root)) return null;
    return full;
}

// ─── GET /api/downloads ──────────────────────────────────────────
// Fichiers de service à ne pas montrer dans l'historique :
// « .aria2 » = fichier de reprise, « <infohash>.torrent » = métadonnées que
// le moteur enregistre à côté du téléchargement. Ce ne sont pas des résultats.
// Taille cumulée d'un dossier (profondeur limitée, erreurs ignorées).
function dirSize(dir, depth = 0) {
    if (depth > 6) return 0;
    let total = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            try {
                if (e.isDirectory()) total += dirSize(full, depth + 1);
                else if (e.isFile() && !isInternalFile(e.name)) total += fs.statSync(full).size;
            } catch { }
        }
    } catch { }
    return total;
}

function isInternalFile(name) {
    return name.endsWith('.part')
        || name.endsWith('.ytdl')
        || name.endsWith('.aria2')
        || /^[0-9a-f]{40}\.torrent$/i.test(name);
}

app.get('/api/downloads', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
            .filter(d => (d.isFile() || d.isDirectory()) && !isInternalFile(d.name))
            .map(d => {
                const full = path.join(DOWNLOADS_DIR, d.name);
                const stats = fs.statSync(full);
                // Un torrent multi-fichiers arrive sous forme de dossier :
                // on en cumule le contenu plutôt que d'afficher 4 ko.
                const size = d.isDirectory() ? dirSize(full) : stats.size;
                return {
                    name: d.name,
                    size,
                    date: stats.mtime,
                    isFolder: d.isDirectory(),
                    // Un dossier vient d'un torrent multi-fichiers : pas d'extension.
                    category: d.isDirectory() ? 'dossier' : aria2lib.fileCategory(d.name),
                };
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(files);
    } catch {
        res.json([]);
    }
});

// Ouvre un fichier / dossier avec l'application par défaut du système,
// sans passer par un shell (plus d'injection possible via le nom de fichier).
function openWithOS(target) {
    if (IS_WINDOWS) {
        // explorer.exe reçoit le chemin en argument séparé : pas d'interprétation shell.
        execFile('explorer.exe', [target], { windowsHide: true }, () => { });
    } else if (process.platform === 'darwin') {
        execFile('open', [target], () => { });
    } else {
        execFile('xdg-open', [target], () => { });
    }
}

// ─── GET /api/open-file ──────────────────────────────────────────
app.get('/api/open-file', (req, res) => {
    const full = resolveInDownloads(req.query.name || req.query.path);
    if (!full || !fs.existsSync(full)) {
        return res.status(404).json({ error: 'Fichier introuvable.' });
    }
    openWithOS(full);
    res.json({ success: true });
});

// ─── GET /api/open-folder — Open the downloads folder ────────────
app.get('/api/open-folder', (req, res) => {
    openWithOS(DOWNLOADS_DIR);
    res.json({ success: true });
});

// ─── POST /api/delete-file — supprime un fichier de l'historique ──
app.post('/api/delete-file', (req, res) => {
    const full = resolveInDownloads((req.body || {}).name);
    if (!full || !fs.existsSync(full)) {
        return res.status(404).json({ error: 'Fichier introuvable.' });
    }
    try {
        fs.unlinkSync(full);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Suppression impossible : ' + e.message });
    }
});

// ─── GET/POST /api/settings ──────────────────────────────────────
app.get('/api/settings', (req, res) => {
    res.json({
        ...settings,
        hasCookieFile: hasCookieFile(),
        downloadsDir: DOWNLOADS_DIR,
        torProfiles: detectTorProfiles(),
        pythonAvailable: !!getPythonPath(),
        impersonateAvailable: impersonateAvailable(),
        impersonateTargets: getImpersonateTargets(),
        syncedCookiesFresh: hasFreshSyncedCookies(),
        maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
        aria2Available: aria2.available,
        aria2Ready: aria2.ready,
        aria2Version: aria2lib.getAria2Version(),
        aria2Error: aria2.ready ? null : aria2.startError,
    });
});

app.post('/api/settings', (req, res) => {
    const body = req.body || {};

    if (body.cookieMode !== undefined) {
        if (!COOKIE_MODES.includes(body.cookieMode)) {
            return res.status(400).json({ error: 'Mode de cookies inconnu.' });
        }
        settings.cookieMode = body.cookieMode;
        invalidateMergedCache();
    }
    if (body.browserChoice !== undefined) {
        // Valeur passée à --cookies-from-browser : liste blanche stricte.
        if (!BROWSER_IDS.includes(body.browserChoice)) {
            return res.status(400).json({ error: 'Navigateur inconnu.' });
        }
        settings.browserChoice = body.browserChoice;
        invalidateMergedCache();
    }
    if (body.concurrentFragments !== undefined) {
        const n = parseInt(body.concurrentFragments, 10);
        if (!Number.isFinite(n) || n < 1 || n > 32) {
            return res.status(400).json({ error: 'concurrentFragments doit être entre 1 et 32.' });
        }
        settings.concurrentFragments = n;
    }
    if (body.torProfile !== undefined) {
        const p = String(body.torProfile || '').slice(0, 512);
        if (p && !fs.existsSync(p)) {
            return res.status(400).json({ error: 'Ce chemin de profil Tor n\'existe pas.' });
        }
        settings.torProfile = p;
        invalidateMergedCache();
    }
    if (body.impersonate !== undefined) {
        const v = String(body.impersonate || 'auto');
        if (v !== 'auto' && v !== 'off' && !getImpersonateTargets().includes(v)) {
            return res.status(400).json({ error: 'Cible d\'impersonation indisponible.' });
        }
        settings.impersonate = v;
    }
    for (const flag of ['embedSubs', 'embedThumbnail', 'embedMetadata', 'insecureTLS']) {
        if (body[flag] !== undefined) settings[flag] = !!body[flag];
    }
    if (body.seedAfterDownload !== undefined) {
        settings.seedAfterDownload = !!body.seedAfterDownload;
        // Le partage continue après réception : on l'applique à chaud.
        if (aria2.ready) {
            aria2.call('aria2.changeGlobalOption', [{
                'seed-ratio': settings.seedAfterDownload ? '1.0' : '0.0',
                'seed-time': settings.seedAfterDownload ? '' : '0',
            }]).catch(() => { });
        }
    }
    if (body.btListenPort !== undefined) {
        const n = parseInt(body.btListenPort, 10) || 0;
        if (n !== 0 && (n < 1024 || n > 65535)) {
            return res.status(400).json({ error: 'Le port BitTorrent doit être 0 (automatique) ou compris entre 1024 et 65535.' });
        }
        settings.btListenPort = n;
    }

    saveSettings();
    res.json({ success: true, settings });
});

// ─── GET /api/detect-browsers — Detect installed browsers ────────
app.get('/api/detect-browsers', (req, res) => {
    const browsers = [];
    const home = os.homedir();

    const browserPaths = [
        { id: 'chrome', name: 'Google Chrome', paths: [
            path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]},
        { id: 'firefox', name: 'Mozilla Firefox', paths: [
            path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
            'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        ]},
        { id: 'edge', name: 'Microsoft Edge', paths: [
            path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]},
        { id: 'brave', name: 'Brave', paths: [
            path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
        ]},
        { id: 'opera', name: 'Opera', paths: [
            path.join(home, 'AppData', 'Roaming', 'Opera Software', 'Opera Stable'),
        ]},
        { id: 'vivaldi', name: 'Vivaldi', paths: [
            path.join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
        ]},
    ];

    for (const browser of browserPaths) {
        if (browser.paths.some(p => fs.existsSync(p))) {
            browsers.push({ id: browser.id, name: browser.name });
        }
    }

    if (!browsers.find(b => b.id === 'chrome')) {
        browsers.unshift({ id: 'chrome', name: 'Google Chrome' });
    }

    res.json(browsers);
});

// ─── GET /api/test-cookies — Test if cookie extraction works ─────
app.get('/api/test-cookies', (req, res) => {
    const ytdlp = getYtDlpPath();
    const mode = settings.cookieMode;

    const countCookies = (file) => {
        try {
            return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        } catch { return 0; }
    };

    if (mode === 'extension') {
        if (hasFreshSyncedCookies()) {
            return res.json({ success: true, message: `Cookies de l'extension actifs ✅ (${countCookies(SYNCED_COOKIES_FILE)} cookies)` });
        }
        return res.json({ success: false, message: "Aucun cookie récent de l'extension. Cliquez sur « Synchroniser » dans l'extension du navigateur." });
    }

    if (mode === 'all') {
        const merged = buildMergedCookies();
        if (merged) {
            return res.json({ success: true, message: `Fusion réussie ✅ (${countCookies(merged)} cookies récupérés depuis vos navigateurs + Tor)` });
        }
        if (!getPythonPath()) {
            return res.json({ success: false, message: "Python introuvable. Le mode multi-navigateurs nécessite Python (installé avec yt-dlp via pip)." });
        }
        return res.json({ success: false, message: "Aucun cookie récupéré. Chrome/Edge/Brave (v127+) bloquent l'extraction quand ils sont ouverts — Firefox/Tor fonctionnent même ouverts." });
    }

    let testArgs;
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    if (mode === 'browser') {
        const browser = BROWSER_IDS.includes(settings.browserChoice) ? settings.browserChoice : 'chrome';
        testArgs = ['--cookies-from-browser', browser, '--dump-json', '--no-warnings', '--simulate', '--', testUrl];
    } else if (mode === 'file' && hasCookieFile()) {
        testArgs = ['--cookies', COOKIES_FILE, '--dump-json', '--no-warnings', '--simulate', '--', testUrl];
    } else {
        return res.json({ success: false, message: 'Aucun mode de cookies actif.' });
    }

    let stderr = '';
    let replied = false;
    const reply = (payload) => { if (!replied) { replied = true; res.json(payload); } };

    let proc;
    try {
        proc = spawn(ytdlp, testArgs, { windowsHide: true, timeout: 45000 });
    } catch (err) {
        return reply({ success: false, message: 'Impossible de lancer yt-dlp : ' + err.message });
    }

    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (err) => reply({ success: false, message: 'Impossible de lancer yt-dlp : ' + err.message }));
    proc.on('close', (code) => {
        if (code === 0) return reply({ success: true, message: 'Extraction des cookies fonctionnelle ✅' });
        const s = stderr.toLowerCase();
        let errorMsg = 'Échec de l\'extraction des cookies.';
        if (s.includes('decrypt') || s.includes('dpapi')) {
            errorMsg = 'Impossible de déchiffrer les cookies (DPAPI / App-Bound). Fermez le navigateur, ou utilisez l\'extension / un cookies.txt.';
        } else if (s.includes('no suitable')) {
            errorMsg = 'Profil de navigateur introuvable. Vérifiez que le navigateur sélectionné est installé et a déjà servi.';
        } else if (stderr.trim()) {
            errorMsg = stderr.trim().substring(0, 300);
        }
        reply({ success: false, message: errorMsg });
    });
});

// ─── POST /api/upload-cookies — Upload cookies.txt file ──────────
app.post('/api/upload-cookies', (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (!body.trim()) return res.status(400).json({ error: 'Fichier de cookies vide.' });
    if (!/^#|\t/m.test(body)) {
        return res.status(400).json({ error: 'Format non reconnu : un fichier Netscape (cookies.txt) est attendu.' });
    }
    try {
        writeCookieFile(COOKIES_FILE, body);
        settings.cookieMode = 'file'; // auparavant : settings.useCookieFile, champ mort
        saveSettings();
        const count = body.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        res.json({ success: true, count, message: 'Cookies enregistrés.' });
    } catch (e) {
        res.status(500).json({ error: 'Échec de l\'enregistrement : ' + e.message });
    }
});

// ─── POST /api/browser-cookies — cookies pushed by the extension ─
// Reçoit soit du texte Netscape, soit un JSON [{name,value,domain,...}].
app.post('/api/browser-cookies', (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (!body.trim()) return res.status(400).json({ error: 'Cookies vides.' });

    let netscape = '';
    const trimmed = body.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const arr = JSON.parse(trimmed);
            const list = Array.isArray(arr) ? arr : (arr.cookies || []);
            netscape = '# Netscape HTTP Cookie File\n# Généré par l\'extension Video Downloader\n\n';
            for (const c of list) {
                if (!c || !c.name || !c.domain) continue;
                const domain = String(c.domain);
                const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
                const cpath = String(c.path || '/');
                const secure = c.secure ? 'TRUE' : 'FALSE';
                const expiry = c.session ? 0 : Math.round(c.expirationDate || c.expiry || 0);
                // Les tabulations/retours à la ligne casseraient le format Netscape.
                const clean = (v) => String(v).replace(/[\t\r\n]/g, '');
                netscape += [domain, includeSub, cpath, secure, expiry, clean(c.name), clean(c.value)].join('\t') + '\n';
            }
        } catch (e) {
            return res.status(400).json({ error: 'JSON de cookies invalide : ' + e.message });
        }
    } else {
        netscape = body;
        if (!netscape.startsWith('#')) netscape = '# Netscape HTTP Cookie File\n\n' + netscape;
    }

    try {
        writeCookieFile(SYNCED_COOKIES_FILE, netscape);
        invalidateMergedCache();
        const count = netscape.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        if (settings.cookieMode === 'none') settings.cookieMode = 'extension';
        saveSettings();
        console.log(`🍪 Extension : ${count} cookies synchronisés.`);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: 'Échec de l\'enregistrement : ' + e.message });
    }
});

// Pré-vol CORS pour l'extension (l'en-tête d'origine est posé par le middleware)
app.options('/api/browser-cookies', (req, res) => {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

// ─── Check yt-dlp availability ───────────────────────────────────
app.get('/api/check', (req, res) => {
    const ytdlp = getYtDlpPath();
    let replied = false;
    const reply = (payload) => { if (!replied) { replied = true; res.json(payload); } };

    let proc;
    try {
        proc = spawn(ytdlp, ['--version'], { windowsHide: true, timeout: 15000 });
    } catch {
        return reply({ installed: false });
    }

    let version = '';
    proc.stdout.on('data', (d) => { version += d.toString(); });
    proc.on('error', () => reply({ installed: false }));
    proc.on('close', (code) => {
        if (code !== 0) return reply({ installed: false });
        reply({
            installed: true,
            version: version.trim(),
            downloadsDir: DOWNLOADS_DIR,
            hasCookieFile: hasCookieFile(),
        });
    });
});

// ─── Gestionnaire d'erreurs (JSON plutôt que page HTML d'Express) ─
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Fichier trop volumineux.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Corps de requête illisible (JSON invalide).' });
    }
    console.error('Erreur non gérée :', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Erreur interne.' });
});

// ─── Arrêt propre : ne laisse pas de processus yt-dlp orphelins ───
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [, entry] of activeDownloads) {
        entry.cancelled = true;
        if (entry.proc) { try { entry.proc.kill('SIGTERM'); } catch { } }
    }
    activeDownloads.clear();
    // On ATTEND qu'aria2 soit sorti : sinon le processus survit à l'app,
    // rattaché à init, et continue de partager en arrière-plan.
    try { await aria2.stop(); } catch { }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows : Ctrl+C dans une console remonte par cette voie.
if (IS_WINDOWS) {
    try {
        require('readline').createInterface({ input: process.stdin, output: process.stdout })
            .on('SIGINT', shutdown);
    } catch { }
}

// ─── Start server ────────────────────────────────────────────────
// Démarre le moteur BitTorrent en arrière-plan : son absence ne doit pas
// empêcher l'application de servir le reste.
aria2.start({
    seedAfterDownload: settings.seedAfterDownload,
    listenPort: settings.btListenPort || undefined,
}).then((ok) => {
    if (ok) {
        console.log(`  🧲 Moteur torrent : aria2 ${aria2lib.getAria2Version()} (RPC local, port ${aria2.port})`);
        console.log(`  🔁 Partage après téléchargement : ${settings.seedAfterDownload ? 'ACTIVÉ' : 'désactivé'}`);
        trackerslib.loadTrackers(aria2lib.STATE_DIR).then(async (list) => {
            TRACKERS = list;
            try {
                await aria2.changeGlobalOption({ 'bt-tracker': list.join(',') });
                console.log(`  📡 Trackers publics : ${list.length} (liste à jour)`);
            } catch (e) {
                console.log(`  📡 Trackers publics : liste de secours (${e.message})`);
            }
        });
    } else if (!aria2.available) {
        console.log('  🧲 Moteur torrent : aria2 non installé — magnets et torrents indisponibles.');
        console.log('     Windows :  winget install aria2.aria2     (ou scoop/choco install aria2)');
    } else {
        console.log(`  🧲 Moteur torrent : échec du démarrage — ${aria2.startError}`);
    }
});

const server = app.listen(PORT, HOST, () => {
    console.log(`\n  🎬 Video Downloader : http://localhost:${PORT}`);
    console.log(`  🔒 Écoute sur ${HOST} uniquement (inaccessible depuis le réseau)`);
    console.log(`  📁 Téléchargements : ${DOWNLOADS_DIR}`);
    const modeLabels = { browser: `Auto (${settings.browserChoice})`, all: 'Tous navigateurs + Tor', extension: 'Extension navigateur', file: 'cookies.txt', none: 'Désactivé' };
    console.log(`  🍪 Mode cookies : ${modeLabels[settings.cookieMode] || settings.cookieMode}`);
    console.log(`  ⚡ Fragments parallèles : ${settings.concurrentFragments}`);
    const imp = getImpersonateTargets();
    console.log(`  🎭 Impersonation TLS : ${imp.length ? imp.join(', ') : 'INDISPONIBLE — pip install -U "yt-dlp[default]" curl_cffi'}`);
    console.log(`  📍 yt-dlp : ${getYtDlpPath()}\n`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Le port ${PORT} est déjà utilisé. L'application est peut-être déjà lancée.`);
        console.error(`   Lancez-la sur un autre port :  set PORT=3001 && npm start\n`);
    } else {
        console.error('❌ Erreur serveur :', err.message);
    }
    process.exit(1);
});

module.exports = app;
