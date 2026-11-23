// ─── Trackers publics : liste à jour et « scrape » ───────────────────────────
//
// 1. Liste : la liste « best » de ngosang/trackerslist (tenue à jour par la
//    communauté) est récupérée au démarrage et gardée 24 h en cache. Sans
//    réseau, on retombe sur le cache, puis sur une liste fixe.
// 2. Scrape : on demande directement aux trackers combien de sources
//    (seeders) et de clients (leechers) ils connaissent pour un torrent. Ça
//    répond en quelques secondes, sans rejoindre l'essaim, et permet de dire
//    « ce document n'existe plus » au lieu d'une attente muette.

const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BEST_LIST_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_TRACKERS = 40;

// Liste de secours, mélangeant UDP et HTTP(S) : certains réseaux bloquent l'UDP.
const FALLBACK_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://tracker.theoks.net:6969/announce',
    'udp://tracker-udp.gbitt.info:80/announce',
    'https://tracker.opentrackr.org:443/announce',
    'http://tracker.opentrackr.org:1337/announce',
    'https://tracker.gbitt.info:443/announce',
    'http://tracker.files.fm:6969/announce',
];

function parseList(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
            const u = new URL(t);
            if (['udp:', 'http:', 'https:'].includes(u.protocol) && !out.includes(t)) out.push(t);
        } catch { }
        if (out.length >= MAX_TRACKERS) break;
    }
    return out;
}

// Renvoie la meilleure liste disponible, sans jamais lever d'erreur.
async function loadTrackers(stateDir, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const cache = path.join(stateDir, 'trackers.txt');
    let cached = [];
    try {
        const st = fs.statSync(cache);
        cached = parseList(fs.readFileSync(cache, 'utf8'));
        if (cached.length && now() - st.mtimeMs < CACHE_MAX_AGE_MS) return merge(cached);
    } catch { }
    try {
        const r = await fetchImpl(BEST_LIST_URL, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
            const fresh = parseList(await r.text());
            if (fresh.length >= 5) {
                try {
                    fs.mkdirSync(stateDir, { recursive: true });
                    fs.writeFileSync(cache, fresh.join('\n'), 'utf8');
                } catch { }
                return merge(fresh);
            }
        }
    } catch { }
    return merge(cached);
}

function merge(list) {
    const out = [...list];
    for (const t of FALLBACK_TRACKERS) if (!out.includes(t)) out.push(t);
    return out.slice(0, MAX_TRACKERS + FALLBACK_TRACKERS.length);
}

// ─── Identifiant du torrent : hexadécimal (40) ou base32 (32) → 20 octets ───
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function infoHashBytes(hash) {
    const h = String(hash || '').trim();
    if (/^[0-9a-f]{40}$/i.test(h)) return Buffer.from(h, 'hex');
    if (/^[A-Z2-7]{32}$/i.test(h)) {
        let bits = '';
        for (const c of h.toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
        const bytes = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
        return Buffer.from(bytes);
    }
    return null; // btmh (BitTorrent v2) : pas de scrape v1 possible
}

// ─── Scrape UDP (BEP 15) ────────────────────────────────────────────────────
function scrapeUdp(announceUrl, hash20, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(announceUrl); } catch { return resolve(null); }
        const port = Number(u.port) || 80;
        const sock = dgram.createSocket('udp4');
        let done = false, connId = null;
        const tid = crypto.randomBytes(4);
        const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch { } resolve(v); };
        const timer = setTimeout(() => finish(null), timeoutMs);
        sock.on('error', () => finish(null));
        sock.on('message', (msg) => {
            if (msg.length < 8 || !msg.subarray(4, 8).equals(tid)) return;
            const action = msg.readUInt32BE(0);
            if (action === 0 && msg.length >= 16 && !connId) {
                connId = msg.subarray(8, 16);
                const req = Buffer.alloc(36);
                connId.copy(req, 0);
                req.writeUInt32BE(2, 8);  // scrape
                tid.copy(req, 12);
                hash20.copy(req, 16);
                sock.send(req, port, u.hostname, () => { });
            } else if (action === 2 && msg.length >= 20) {
                finish({ seeders: msg.readUInt32BE(8), completed: msg.readUInt32BE(12), leechers: msg.readUInt32BE(16) });
            } else if (action === 3) {
                finish(null); // erreur renvoyée par le tracker
            }
        });
        const req = Buffer.alloc(16);
        req.writeUInt32BE(0x417, 0);       // identifiant de protocole 0x41727101980
        req.writeUInt32BE(0x27101980, 4);
        req.writeUInt32BE(0, 8);           // connect
        tid.copy(req, 12);
        sock.send(req, port, u.hostname, (err) => { if (err) finish(null); });
    });
}

// ─── Scrape HTTP(S) : « announce » → « scrape », réponse bencodée ───────────
async function scrapeHttp(announceUrl, hash20, timeoutMs, fetchImpl = globalThis.fetch) {
    if (!/\/announce(\.php)?(\?|$)/.test(announceUrl)) return null; // pas de scrape possible
    const scrapeUrl = announceUrl.replace(/\/announce(\.php)?/, '/scrape$1');
    let encoded = '';
    for (const b of hash20) encoded += '%' + b.toString(16).padStart(2, '0');
    try {
        const r = await fetchImpl(scrapeUrl + (scrapeUrl.includes('?') ? '&' : '?') + 'info_hash=' + encoded,
            { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) return null;
        const body = Buffer.from(await r.arrayBuffer()).toString('latin1');
        const c = /8:completei(\d+)e/.exec(body);
        const i = /10:incompletei(\d+)e/.exec(body);
        if (!c && !i) return null;
        const d = /10:downloadedi(\d+)e/.exec(body);
        return { seeders: c ? +c[1] : 0, leechers: i ? +i[1] : 0, completed: d ? +d[1] : 0 };
    } catch { return null; }
}

// Interroge tous les trackers en parallèle. « responded » = nombre de
// trackers qui ont répondu ; seeders/leechers = le maximum annoncé ;
// « others » = le plus grand nombre de pairs connus par un même tracker.
//
// À appeler AVANT d'ajouter le torrent au moteur : une fois annoncé, le moteur
// est lui-même compté par les trackers (deux fois, en IPv4 et en IPv6), et un
// document inexistant semblerait avoir des sources. « enough » permet de
// répondre dès que ce nombre de trackers a répondu, sans attendre les morts.
function scrape(infoHash, trackers, { timeoutMs = 6000, enough = Infinity, fetchImpl } = {}) {
    const hash20 = infoHashBytes(infoHash);
    if (!hash20 || hash20.length !== 20) {
        return Promise.resolve({ responded: 0, seeders: 0, leechers: 0, others: 0, supported: false });
    }
    return new Promise((resolve) => {
        const ok = [];
        let pending = trackers.length, done = false;
        const summary = () => {
            const peak = ok.reduce((m, x) => Math.max(m, x.seeders + x.leechers), 0);
            return {
                supported: true,
                responded: ok.length,
                seeders: ok.reduce((m, x) => Math.max(m, x.seeders), 0),
                leechers: ok.reduce((m, x) => Math.max(m, x.leechers), 0),
                others: peak,
            };
        };
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(summary()); } };
        const timer = setTimeout(finish, timeoutMs + 200);
        if (!pending) return finish();
        for (const t of trackers) {
            const p = t.startsWith('udp:') ? scrapeUdp(t, hash20, timeoutMs) : scrapeHttp(t, hash20, timeoutMs, fetchImpl);
            p.then((r) => {
                if (done) return;
                if (r) ok.push(r);
                if (--pending === 0 || ok.length >= enough) finish();
            }, () => { if (!done && --pending === 0) finish(); });
        }
    });
}

module.exports = { loadTrackers, scrape, parseList, infoHashBytes, scrapeUdp, scrapeHttp, FALLBACK_TRACKERS };
