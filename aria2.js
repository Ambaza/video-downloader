// ═══════════════════════════════════════════════════════════════
// aria2 — moteur pour magnet, .torrent et fichiers directs
//
// yt-dlp ne sait pas traiter un magnet : ce n'est pas une URL de fichier
// mais un identifiant de contenu (btih) plus une liste de trackers. Il
// n'existe aucun serveur à interroger — il faut rejoindre un essaim de
// pairs, récupérer d'abord les métadonnées du torrent, puis assembler le
// fichier morceau par morceau. C'est le rôle d'aria2, qui couvre au
// passage HTTP/FTP/SFTP et remplace donc aussi le téléchargement direct.
//
// aria2 tourne en démon, piloté en JSON-RPC sur la boucle locale avec un
// secret tiré au hasard à chaque démarrage.
// ═══════════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('child_process');
const { randomBytes, randomUUID } = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_WINDOWS = process.platform === 'win32';

// État persistant d'aria2 (table DHT), hors du dossier de téléchargements.
const STATE_DIR = path.join(os.homedir(), '.video-downloader');

// Trackers publics ajoutés à chaque torrent : un magnet copié depuis un moteur
// de recherche n'en contient souvent aucun. La liste de secours sert au
// démarrage ; server.js la remplace par la liste à jour dès qu'elle est chargée.
const { FALLBACK_TRACKERS } = require('./trackers.js');

// ─── Localisation du binaire ─────────────────────────────────────
let _aria2Path = null;
let _aria2Checked = false;

function getAria2Path() {
    if (_aria2Checked) return _aria2Path;
    _aria2Checked = true;

    const exe = IS_WINDOWS ? 'aria2c.exe' : 'aria2c';
    const candidates = [path.join(__dirname, 'bin', exe)];

    if (IS_WINDOWS) {
        candidates.push(
            'C:\\Program Files\\aria2\\aria2c.exe',
            'C:\\Program Files (x86)\\aria2\\aria2c.exe',
            path.join(os.homedir(), 'scoop', 'shims', 'aria2c.exe'),
            // winget : lien posé ici, mais absent du PATH d'un processus lancé
            // avant l'installation (le hub du catalogue, par exemple).
            path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
            path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'aria2c.exe'),
        );
    } else {
        candidates.push('/usr/local/bin/aria2c', '/usr/bin/aria2c', '/opt/homebrew/bin/aria2c');
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) { _aria2Path = p; return _aria2Path; }
    }

    // Dernier recours : le PATH
    try {
        const r = spawnSync(exe, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        if (r.status === 0) { _aria2Path = exe; return _aria2Path; }
    } catch { }

    _aria2Path = null;
    return null;
}

function getAria2Version() {
    const bin = getAria2Path();
    if (!bin) return null;
    try {
        const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        const m = (r.stdout || '').match(/aria2 version ([\d.]+)/i);
        return m ? m[1] : null;
    } catch { return null; }
}

// ─── Choix d'un port RPC libre sur la boucle locale ──────────────
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// ─── Le démon ────────────────────────────────────────────────────
class Aria2 {
    constructor({ downloadsDir, onLog } = {}) {
        this.downloadsDir = downloadsDir;
        this.onLog = onLog || (() => { });
        this.proc = null;
        this.port = null;
        // Secret tiré à chaque démarrage : sans lui, tout processus local
        // pourrait mettre en file un téléchargement et écrire sur le disque.
        this.secret = randomBytes(24).toString('hex');
        this.ready = false;
        this.startError = null;
    }

    get available() { return !!getAria2Path(); }

    async start(options = {}) {
        if (this.proc) return true;
        const bin = getAria2Path();
        if (!bin) { this.startError = 'aria2c introuvable'; return false; }

        this.port = await findFreePort();
        try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { }

        const seedRatio = options.seedAfterDownload ? '1.0' : '0.0';
        const seedTime = options.seedAfterDownload ? '' : '--seed-time=0';

        const args = [
            '--enable-rpc',
            // Jamais exposé au réseau : uniquement 127.0.0.1.
            '--rpc-listen-all=false',
            `--rpc-listen-port=${this.port}`,
            `--rpc-secret=${this.secret}`,
            // Le dossier de sortie est verrouillé ici. Les noms de fichiers
            // contenus dans un .torrent sont choisis par son auteur : on ne
            // laisse jamais le torrent décider d'un chemin hors de ce dossier.
            `--dir=${this.downloadsDir}`,
            '--continue=true',
            '--always-resume=true',
            '--auto-file-renaming=true',
            '--content-disposition-default-utf8=true',
            // Les téléchargements issus d'un magnet naissent en pause : on
            // veut montrer la liste des fichiers avant de lancer quoi que ce soit.
            '--pause-metadata=true',
            '--bt-save-metadata=true',
            // Les morceaux BitTorrent chevauchent les frontières de fichiers :
            // désélectionner un fichier n'empêche pas d'en recevoir les bouts
            // partagés avec un fichier voulu. Sans cette option, l'utilisateur
            // retrouve sur son disque un fichier de la taille annoncée, rempli
            // de zéros à 96 %. aria2 le supprime donc une fois le reste terminé.
            '--bt-remove-unselected-file=true',
            // Pas de pré-allocation : sinon un torrent de 40 Go réserve 40 Go
            // avant d'avoir reçu le premier octet, même en sélection partielle.
            '--file-allocation=none',
            '--follow-torrent=true',
            '--enable-dht=true',
            // Un magnet sans tracker (« magnet:?xt=urn:btih:… » seul) ne trouve
            // ses pairs que par le DHT. Sans point d'entrée ni table enregistrée,
            // le DHT d'aria2 démarre vide à chaque lancement et le magnet reste
            // indéfiniment à 0 octet : on l'amorce, et on garde la table entre
            // deux lancements.
            '--dht-entry-point=dht.transmissionbt.com:6881',
            `--dht-file-path=${path.join(STATE_DIR, 'dht.dat')}`,
            // Une bonne part des pairs n'est joignable qu'en IPv6.
            '--enable-dht6=true',
            '--dht-entry-point6=dht.transmissionbt.com:6881',
            `--dht-file-path6=${path.join(STATE_DIR, 'dht6.dat')}`,
            '--enable-peer-exchange=true',
            // Trackers publics ajoutés à chaque torrent, en plus des siens.
            `--bt-tracker=${FALLBACK_TRACKERS.join(',')}`,
            // Un tracker mort bloquait 60 s par défaut avant d'être abandonné.
            '--bt-tracker-connect-timeout=10',
            '--bt-tracker-timeout=15',
            // aria2 cherche de nouveaux pairs tant que le débit d'un torrent
            // reste sous cette valeur (50 Kio/s par défaut, bien trop bas).
            '--bt-request-peer-speed-limit=2M',
            '--bt-enable-lpd=true',
            '--bt-max-peers=120',
            `--seed-ratio=${seedRatio}`,
            // La recherche des métadonnées d'un magnet occupe une place dans
            // cette file : à 3, un lot de magnets restait en attente sans même
            // chercher, et expirait comme s'il n'existait pas. Le nombre de
            // vrais téléchargements simultanés est limité par server.js.
            '--max-concurrent-downloads=24',
            '--max-connection-per-server=8',
            '--split=8',
            '--min-split-size=4M',
            '--check-certificate=true',
            '--summary-interval=0',
            '--console-log-level=warn',
            '--download-result=hide',
            '--quiet=false',
        ];
        if (seedTime) args.push(seedTime);
        if (options.listenPort) args.push(`--listen-port=${options.listenPort}`);

        this.proc = spawn(bin, args, { windowsHide: true });
        this.proc.stdout.on('data', d => this.onLog(d.toString().trim()));
        this.proc.stderr.on('data', d => this.onLog(d.toString().trim()));
        this.proc.on('exit', (code) => {
            this.ready = false;
            this.proc = null;
            if (code !== 0 && code !== null) this.onLog(`aria2 s'est arrêté (code ${code})`);
        });
        this.proc.on('error', (err) => {
            this.startError = err.message;
            this.ready = false;
            this.proc = null;
        });

        // Attend que le RPC réponde (démarrage quasi instantané, mais on boucle)
        for (let i = 0; i < 40; i++) {
            if (!this.proc) break;
            try {
                await this.call('aria2.getVersion');
                this.ready = true;
                return true;
            } catch {
                await new Promise(r => setTimeout(r, 150));
            }
        }
        this.startError = this.startError || 'aria2 n\'a pas répondu sur son interface RPC';
        return false;
    }

    // Arrêt propre. aria2 doit enregistrer son état avant de sortir : si le
    // processus parent quitte tout de suite après un simple SIGTERM, aria2
    // survit, rattaché à init, et continue de tourner en fond.
    async stop({ timeoutMs = 4000 } = {}) {
        const p = this.proc;
        if (!p) return;
        this.proc = null;
        this.ready = false;

        const exited = new Promise(resolve => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            p.once('exit', done);
            setTimeout(done, timeoutMs);
        });

        // 1) Arrêt demandé par RPC — la voie propre, et la seule fiable sous Windows
        try { await this.call('aria2.forceShutdown'); } catch { }
        // 2) Filet : signal, puis SIGKILL si le processus s'accroche
        try { p.kill('SIGTERM'); } catch { }
        const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { } }, timeoutMs - 1000);

        await exited;
        clearTimeout(killer);
        try { p.kill('SIGKILL'); } catch { }
    }

    async call(method, params = []) {
        if (!this.port) throw new Error('aria2 non démarré');
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method,
            params: [`token:${this.secret}`, ...params],
        });
        const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(20000),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message || 'Erreur aria2');
        return json.result;
    }

    // ─── Opérations de haut niveau ───────────────────────────────

    addUri(uris, options = {}) { return this.call('aria2.addUri', [uris, options]); }
    changeGlobalOption(options) { return this.call('aria2.changeGlobalOption', [options]); }

    // Retrouve un téléchargement déjà connu d'aria2 pour ce torrent (actif, en
    // attente ou en pause). Sert quand un magnet est recollé avant la fin de sa
    // première recherche : aria2 refuse alors un second ajout (« already
    // registered »).
    async findByInfoHash(infoHashHex) {
        const want = String(infoHashHex || '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(want)) return null;
        const keys = ['gid', 'infoHash', 'status', 'followedBy', 'following'];
        const lists = await Promise.all([
            this.call('aria2.tellActive', [keys]).catch(() => []),
            this.call('aria2.tellWaiting', [0, 1000, keys]).catch(() => []),
        ]);
        return lists.flat().find(s => String(s.infoHash || '').toLowerCase() === want) || null;
    }

    addTorrentBase64(b64, options = {}) {
        return this.call('aria2.addTorrent', [b64, [], options]);
    }

    tellStatus(gid, keys) {
        return keys ? this.call('aria2.tellStatus', [gid, keys])
                    : this.call('aria2.tellStatus', [gid]);
    }

    pause(gid) { return this.call('aria2.forcePause', [gid]); }
    unpause(gid) { return this.call('aria2.unpause', [gid]); }
    changeOption(gid, options) { return this.call('aria2.changeOption', [gid, options]); }

    async remove(gid) {
        try { await this.call('aria2.forceRemove', [gid]); } catch { }
        try { await this.call('aria2.removeDownloadResult', [gid]); } catch { }
    }

    // Attend la fin de la phase « métadonnées » d'un magnet.
    //
    // Piège classique : aria2 traite la récupération des métadonnées comme un
    // téléchargement à part entière, qui se termine en quelques secondes. Le
    // vrai téléchargement est un SECOND identifiant, publié dans `followedBy`.
    // Suivre naïvement le premier fait afficher « terminé » instantanément,
    // avec un fichier de quelques kilo-octets.
    async waitForMetadata(metaGid, { timeoutMs = 90000, signal } = {}) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (signal && signal.aborted) throw Object.assign(new Error('annulé'), { code: 'SEARCH_STOPPED' });
            const st = await this.tellStatus(metaGid);

            if (st.followedBy && st.followedBy.length) {
                return st.followedBy[0];
            }
            if (st.status === 'error') {
                throw new Error(st.errorMessage || 'Échec de la récupération des métadonnées');
            }
            if (st.status === 'complete' && !(st.followedBy || []).length) {
                // Métadonnées récupérées mais rien derrière : torrent vide/invalide
                throw new Error('Le torrent ne contient aucun fichier exploitable');
            }
            await new Promise(r => setTimeout(r, 500));
        }
        // Le nombre de connexions d'aria2 compte aussi des échanges qui ne sont
        // pas des pairs possédant le torrent (un identifiant inventé en montre
        // déjà) : il ne permet pas de distinguer un torrent mort d'un torrent
        // rare. Un seul message, honnête.
        const minutes = Math.round(timeoutMs / 60000);
        throw Object.assign(new Error(`Aucune source n'a pu fournir ce torrent en ${minutes} minutes (trackers publics et réseau DHT interrogés). `
            + 'Le plus souvent, il n\'est plus partagé par personne, et aucune application ne pourra le télécharger : '
            + 'cherchez un autre lien pour le même contenu, avec des sources actives (seeders). '
            + 'S\'il est seulement très rare, réessayez plus tard.'), { code: 'SEARCH_STOPPED' });
    }
}

// ─── Validation d'un magnet ──────────────────────────────────────
// btih = 40 caractères hexadécimaux (SHA-1) ou 32 en base32.
const BTIH_HEX = /^[0-9a-fA-F]{40}$/;
const BTIH_B32 = /^[A-Z2-7]{32}$/;
// BitTorrent v2 : 64 caractères hexadécimaux (SHA-256)
const BTMH_HEX = /^1220[0-9a-fA-F]{64}$/;

function sanitizeMagnet(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value.toLowerCase().startsWith('magnet:?')) return null;
    if (value.length > 8192) return null;

    let params;
    try { params = new URLSearchParams(value.slice('magnet:?'.length)); }
    catch { return null; }

    // Identifiant du contenu — obligatoire, et c'est lui qu'on valide.
    const xts = params.getAll('xt').concat(params.getAll('xt.1'), params.getAll('xt.2'));
    let infoHash = null;
    for (const xt of xts) {
        let m = /^urn:btih:(.+)$/i.exec(xt);
        if (m && (BTIH_HEX.test(m[1]) || BTIH_B32.test(m[1].toUpperCase()))) {
            infoHash = m[1].toLowerCase();
            break;
        }
        m = /^urn:btmh:(.+)$/i.exec(xt);
        if (m && BTMH_HEX.test(m[1])) { infoHash = m[1].toLowerCase(); break; }
    }
    if (!infoHash) return null;

    // On reconstruit le magnet à partir des seuls champs utiles, au lieu de
    // repasser la chaîne brute : tout paramètre inattendu est écarté.
    const out = new URLSearchParams();
    for (const xt of xts) out.append('xt', xt);

    const dn = params.get('dn');
    if (dn) out.append('dn', dn.slice(0, 300));

    let trackers = 0;
    for (const tr of params.getAll('tr')) {
        if (trackers >= 30) break;
        try {
            const u = new URL(tr);
            if (['udp:', 'http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
                out.append('tr', tr);
                trackers++;
            }
        } catch { }
    }
    for (const ws of params.getAll('ws').slice(0, 5)) {
        try {
            const u = new URL(ws);
            if (u.protocol === 'http:' || u.protocol === 'https:') out.append('ws', ws);
        } catch { }
    }

    return { magnet: 'magnet:?' + out.toString(), infoHash, displayName: dn || null };
}

function isMagnet(raw) {
    return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('magnet:?');
}

// ─── Nature des fichiers ─────────────────────────────────────────
// Au bout d'un magnet on trouve de tout : vidéos, musique, livres,
// archives, images disque, exécutables… L'interface s'appuie là-dessus
// pour trier, filtrer et prévenir quand c'est utile.
const CATEGORIES = {
    video:    'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m2ts mts vob ogv rm rmvb 3gp divx',
    audio:    'mp3 flac wav aac ogg oga opus m4a m4b wma alac aiff ape mid midi dsf',
    image:    'jpg jpeg png gif bmp webp svg tif tiff heic heif avif psd xcf cr2 nef arw dng',
    document: 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md epub mobi azw azw3 djvu chm pages numbers key',
    archive:  'zip rar 7z tar gz tgz bz2 xz zst lz4 cab arj lzh ace',
    disque:   'iso img dmg vhd vhdx vmdk bin cue mds mdf nrg',
    logiciel: 'exe msi apk deb rpm appimage pkg dmg bat cmd ps1 vbs scr com jar msix appx',
    soustitre:'srt ass ssa vtt sub idx sup',
    donnees:  'json xml csv sql db sqlite nfo sfv md5 par2 torrent cue m3u m3u8 log ini cfg',
};

const EXT_TO_CATEGORY = (() => {
    const map = new Map();
    for (const [cat, exts] of Object.entries(CATEGORIES)) {
        for (const e of exts.split(' ')) if (!map.has(e)) map.set(e, cat);
    }
    return map;
})();

// Extensions qui s'exécutent en double-cliquant : c'est par là que passent
// les mauvaises surprises d'un torrent. On ne bloque rien, on le signale.
const EXECUTABLE_EXTS = new Set(
    'exe msi bat cmd ps1 vbs scr com jar apk appimage deb rpm pkg msix appx sh'.split(' ')
);

function fileExtension(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function fileCategory(name) {
    const ext = fileExtension(name);
    if (!ext) return 'autre';
    return EXT_TO_CATEGORY.get(ext) || 'autre';
}

function isExecutable(name) {
    return EXECUTABLE_EXTS.has(fileExtension(name));
}

// ─── Mise en forme ───────────────────────────────────────────────
function formatBytes(n) {
    n = Number(n) || 0;
    if (!n) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
    const n = Number(bytesPerSec) || 0;
    return n ? `${formatBytes(n)}/s` : '—';
}

function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds > 86400 * 7) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
}

// Traduit un statut aria2 vers la forme attendue par l'interface.
function mapStatus(st) {
    const total = Number(st.totalLength) || 0;
    const done = Number(st.completedLength) || 0;
    const speed = Number(st.downloadSpeed) || 0;
    const up = Number(st.uploadSpeed) || 0;
    const uploaded = Number(st.uploadLength) || 0;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const eta = speed > 0 && total > done ? (total - done) / speed : null;

    const out = {
        percent: pct.toFixed(1) + '%',
        speed: formatSpeed(speed),
        eta: eta != null ? formatEta(eta) : '—',
        size: formatBytes(total),
        downloaded: formatBytes(done),
    };

    if (st.bittorrent) {
        out.torrent = {
            peers: Number(st.connections) || 0,
            seeders: Number(st.numSeeders) || 0,
            uploadSpeed: formatSpeed(up),
            uploaded: formatBytes(uploaded),
            ratio: done > 0 ? (uploaded / done).toFixed(2) : '0.00',
        };
    }
    return out;
}

// Nom lisible d'un téléchargement aria2.
function statusName(st) {
    if (st.bittorrent && st.bittorrent.info && st.bittorrent.info.name) return st.bittorrent.info.name;
    if (st.files && st.files[0] && st.files[0].path) return path.basename(st.files[0].path);
    return '';
}

// Liste des fichiers d'un torrent, pour l'écran de sélection.
function listFiles(st, downloadsDir) {
    const root = path.resolve(downloadsDir);
    return (st.files || []).map((f) => {
        const full = path.resolve(f.path || '');
        // Un .torrent peut nommer ses fichiers comme il veut, « ../ » compris.
        // On n'affiche que ce qui retombe bien dans le dossier de sortie.
        const inside = full === root || full.startsWith(root + path.sep);
        const name = inside ? path.relative(root, full) : path.basename(full);
        return {
            index: Number(f.index),
            name,
            size: Number(f.length) || 0,
            sizeLabel: formatBytes(f.length),
            selected: f.selected === 'true',
            suspicious: !inside,
            ext: fileExtension(name),
            category: fileCategory(name),
            executable: isExecutable(name),
        };
    });
}

module.exports = {
    Aria2,
    STATE_DIR,
    findFreePort,
    fileCategory,
    fileExtension,
    isExecutable,
    CATEGORIES,
    getAria2Path,
    getAria2Version,
    sanitizeMagnet,
    isMagnet,
    mapStatus,
    statusName,
    listFiles,
    formatBytes,
    formatSpeed,
    formatEta,
};
