// ─── Moteur BitTorrent libtorrent (bt_engine.py), piloté comme aria2 ─────────
//
// aria2 ne parle ni µTP ni l'extension « holepunch », et n'ouvre pas de port
// sur la box (UPnP / NAT-PMP) : sur un torrent rare dont les dernières sources
// sont elles-mêmes derrière une box, aucune connexion n'est possible.
// libtorrent (le moteur de qBittorrent) gère les trois.
//
// bt_engine.py expose le même JSON-RPC qu'aria2 : cette classe hérite donc de
// tout le client aria2 et ne remplace que le démarrage. Au premier lancement,
// elle installe libtorrent dans un environnement Python propre à l'appli
// (.venv-bt). Tant que ce n'est pas prêt, ou si ça échoue, server.js continue
// d'utiliser aria2 pour les torrents.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Aria2, STATE_DIR, findFreePort } = require('./aria2.js');

const IS_WINDOWS = process.platform === 'win32';
const LIBTORRENT_VERSION = '2.1.1';
const VENV_DIR = path.join(__dirname, '.venv-bt');
const ENGINE_SCRIPT = path.join(__dirname, 'bt_engine.py');

// Variables propres à l'interpréteur qui lance l'appli : transmises, elles
// détournent un autre Python (voir le hub du catalogue).
function cleanEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
        if (['PYTHONUSERBASE', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONEXECUTABLE', '__PYVENV_LAUNCHER__'].includes(k.toUpperCase())) delete env[k];
    }
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    return env;
}

// Exécute une commande et renvoie { code, out } sans jamais lever d'erreur.
function run(cmd, args, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
        let out = '';
        let p;
        try {
            p = spawn(cmd, args, { windowsHide: true, env: cleanEnv() });
        } catch (e) {
            return resolve({ code: -1, out: e.message });
        }
        const timer = setTimeout(() => { try { p.kill(); } catch { } }, timeoutMs);
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
        p.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    });
}

function venvPython() {
    return path.join(VENV_DIR, IS_WINDOWS ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
}

// Un Python 3.9+ de la machine, pour créer l'environnement.
async function findBasePython() {
    const candidates = IS_WINDOWS
        ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3']], ['python', []]]
        : [['python3', []], ['python', []]];
    for (const [cmd, pre] of candidates) {
        const r = await run(cmd, [...pre, '-c', 'import sys; print(sys.version_info >= (3, 9))'], { timeoutMs: 15000 });
        if (r.code === 0 && /True/.test(r.out)) return [cmd, pre];
    }
    return null;
}

class LibtorrentEngine extends Aria2 {
    constructor(opts = {}) {
        super(opts);
        this.engineName = 'libtorrent';
        this.status = 'arrêté';
    }

    get available() { return true; }   // s'installe tout seul au besoin

    async libtorrentReady() {
        if (!fs.existsSync(venvPython())) return false;
        const r = await run(venvPython(), ['-I', '-c', 'import libtorrent'], { timeoutMs: 30000 });
        return r.code === 0;
    }

    async install() {
        this.status = 'installation';
        const base = await findBasePython();
        if (!base) throw new Error('aucun Python 3.9+ trouvé sur ce PC');
        if (!fs.existsSync(venvPython())) {
            this.onLog('installation de libtorrent : création de l\'environnement Python…');
            const r = await run(base[0], [...base[1], '-m', 'venv', VENV_DIR], { timeoutMs: 180000 });
            if (r.code !== 0) throw new Error('création de l\'environnement impossible : ' + r.out.slice(-300));
        }
        this.onLog(`installation de libtorrent ${LIBTORRENT_VERSION} (une seule fois, quelques minutes)…`);
        const r = await run(venvPython(), ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '-q',
            `libtorrent==${LIBTORRENT_VERSION}`], { timeoutMs: 15 * 60000 });
        if (r.code !== 0) throw new Error('installation de libtorrent impossible : ' + r.out.slice(-300));
    }

    async start(options = {}) {
        if (this.proc) return true;
        try {
            if (!(await this.libtorrentReady())) await this.install();
            if (!(await this.libtorrentReady())) throw new Error('libtorrent installé mais introuvable');
        } catch (e) {
            this.startError = e.message;
            this.status = 'indisponible';
            return false;
        }
        this.status = 'démarrage';
        this.port = await findFreePort();
        try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { }
        const args = ['-I', ENGINE_SCRIPT, '--port', String(this.port), '--secret', this.secret,
            '--dir', this.downloadsDir, '--state', STATE_DIR, '--seed', options.seedAfterDownload ? '1' : '0'];

        this.proc = spawn(venvPython(), args, { windowsHide: true, env: cleanEnv() });
        this.proc.stdout.on('data', d => this.onLog(d.toString().trim()));
        this.proc.stderr.on('data', d => this.onLog(d.toString().trim()));
        this.proc.on('exit', (code) => {
            this.ready = false;
            this.proc = null;
            this.status = 'arrêté';
            if (code !== 0 && code !== null) this.onLog(`le moteur libtorrent s'est arrêté (code ${code})`);
        });
        this.proc.on('error', (err) => {
            this.startError = err.message;
            this.ready = false;
            this.proc = null;
        });

        for (let i = 0; i < 60; i++) {
            if (!this.proc) break;
            try {
                const v = await this.call('aria2.getVersion');
                this.version = v.version;
                this.ready = true;
                this.status = 'prêt';
                return true;
            } catch {
                await new Promise(r => setTimeout(r, 250));
            }
        }
        this.startError = this.startError || 'le moteur libtorrent n\'a pas répondu';
        this.status = 'indisponible';
        try { this.proc && this.proc.kill(); } catch { }
        return false;
    }
}

module.exports = { LibtorrentEngine };
