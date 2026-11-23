"""Moteur BitTorrent fondé sur libtorrent, piloté comme aria2.

Pourquoi : aria2 ne parle ni µTP ni l'extension « holepunch » (BEP 55), et
n'ouvre pas de port sur la box (UPnP / NAT-PMP). Sur un torrent rare dont les
dernières sources sont elles-mêmes derrière une box, aucune connexion n'est
alors possible. libtorrent (le moteur de qBittorrent) gère les trois.

Ce programme expose un sous-ensemble du JSON-RPC d'aria2 sur 127.0.0.1, avec
le même jeton secret et les mêmes champs de statut : l'application Node le
pilote avec le même code que aria2. Comme aria2 avec --pause-metadata, un
magnet produit deux identifiants : celui des métadonnées (qui passe à
« complete » et publie le suivant dans followedBy), puis celui du torrent,
qui naît en pause le temps de choisir les fichiers.

Lancement : python bt_engine.py --port P --secret S --dir DOSSIER --state ETAT
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import libtorrent as lt

MAX_TORRENT_FILE = 10 * 1024 * 1024
# Trackers de secours, utilisés dès le démarrage : sans eux, un magnet sans
# tracker ne dépend que de l'amorçage du DHT, parfois lent (plus d'une minute).
# La liste à jour (trackers.txt, écrite par trackers.js) les remplace si elle
# existe ; l'application peut aussi en envoyer une par changeGlobalOption.
FALLBACK_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://explodie.org:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "https://tracker.opentrackr.org:443/announce",
    "http://tracker.opentrackr.org:1337/announce",
]
DHT_NODES = ("dht.transmissionbt.com:6881,router.bittorrent.com:6881,"
             "router.utorrent.com:6881,dht.libtorrent.org:25401")


class RpcError(Exception):
    pass


def new_gid() -> str:
    return secrets.token_hex(8)


class Engine:
    def __init__(self, save_dir: str, state_dir: str, seed: bool):
        self.save_dir = save_dir
        self.state_file = os.path.join(state_dir, "libtorrent.state")
        self.seed = seed
        self.trackers: list[str] = list(FALLBACK_TRACKERS)
        try:
            with open(os.path.join(state_dir, "trackers.txt"), encoding="utf-8") as f:
                cached = [t.strip() for t in f if t.strip().startswith(("udp://", "http://", "https://"))]
            if len(cached) >= 5:
                self.trackers = cached + [t for t in FALLBACK_TRACKERS if t not in cached]
        except OSError:
            pass
        self.lock = threading.RLock()
        self.items: dict[str, dict] = {}      # gid -> entrée
        self.stopping = False
        os.makedirs(state_dir, exist_ok=True)
        os.makedirs(save_dir, exist_ok=True)

        params = lt.session_params()
        try:
            with open(self.state_file, "rb") as f:
                params = lt.read_session_params(f.read())   # table DHT, etc.
        except Exception:
            pass
        params.settings = {
            "listen_interfaces": "0.0.0.0:0,[::]:0",
            "enable_dht": True, "enable_lsd": True,
            "enable_upnp": True, "enable_natpmp": True,
            "enable_outgoing_utp": True, "enable_incoming_utp": True,
            "enable_outgoing_tcp": True, "enable_incoming_tcp": True,
            "dht_bootstrap_nodes": DHT_NODES,
            "connections_limit": 500,
            "announce_to_all_trackers": True, "announce_to_all_tiers": True,
            "alert_mask": lt.alert_category.status | lt.alert_category.error | lt.alert_category.storage,
        }
        self.ses = lt.session(params)
        threading.Thread(target=self._alerts_loop, daemon=True).start()
        threading.Thread(target=self._save_loop, daemon=True).start()

    # ─── État persistant (table DHT) ─────────────────────────────────────
    def save_state(self) -> None:
        try:
            data = lt.write_session_params_buf(self.ses.session_state())
            tmp = self.state_file + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, self.state_file)
        except Exception:
            pass

    def _save_loop(self) -> None:
        while not self.stopping:
            time.sleep(300)
            self.save_state()

    # ─── Événements libtorrent ───────────────────────────────────────────
    def _alerts_loop(self) -> None:
        while not self.stopping:
            self.ses.wait_for_alert(1000)
            for a in self.ses.pop_alerts():
                if isinstance(a, lt.torrent_finished_alert):
                    self._on_finished(a.handle)
                elif isinstance(a, lt.cache_flushed_alert):
                    self._on_flushed(a.handle)
                elif isinstance(a, lt.torrent_paused_alert):
                    self._on_paused(a.handle)
                elif isinstance(a, lt.torrent_error_alert):
                    with self.lock:
                        for it in self.items.values():
                            if it["handle"] == a.handle:
                                it["error"] = a.message()

    def _main_of(self, h):
        return next((it for it in self.items.values()
                     if it["kind"] == "main" and it["handle"] == h and it["started"]), None)

    # Téléchargement fini : on n'annonce « complete » qu'une fois les données
    # écrites sur le disque (sinon le fichier ouvert aussitôt peut être
    # incomplet pendant une à trois secondes).
    def _on_finished(self, h) -> None:
        with self.lock:
            if not self._main_of(h):
                return
        h.flush_cache()

    def _on_flushed(self, h) -> None:
        with self.lock:
            main = self._main_of(h)
            if not main or main["complete"]:
                return
            main["complete"] = True
        if not self.seed:
            h.pause()   # pas de partage après téléchargement

    # Les fichiers non choisis : libtorrent garde leurs morceaux partagés avec
    # les fichiers voulus dans un « .parts ». On le supprime une fois le
    # torrent en pause (Windows refuse de supprimer un fichier encore ouvert),
    # comme aria2 avec --bt-remove-unselected-file.
    def _on_paused(self, h) -> None:
        with self.lock:
            main = self._main_of(h)
            if not main or not main["complete"] or self.seed:
                return
        try:
            parts = os.path.join(self.save_dir, f".{h.info_hash()}.parts")
            if os.path.exists(parts):
                os.remove(parts)
        except Exception:
            pass

    # ─── Ajout ───────────────────────────────────────────────────────────
    def add_uri(self, uris: list, options: dict | None = None) -> str:
        if not uris:
            raise RpcError("Aucune URI fournie")
        uri = str(uris[0])
        if uri.lower().startswith("magnet:"):
            p = lt.parse_magnet_uri(uri)
        elif uri.lower().startswith(("http://", "https://")):
            with urllib.request.urlopen(uri, timeout=30) as r:
                data = r.read(MAX_TORRENT_FILE + 1)
            if len(data) > MAX_TORRENT_FILE:
                raise RpcError("Fichier .torrent trop volumineux")
            p = lt.add_torrent_params()
            p.ti = lt.torrent_info(lt.bdecode(data))
        else:
            raise RpcError("Seuls les magnets et les URL .torrent sont pris en charge")

        p.save_path = self.save_dir
        # Mode « envoi seul » : les métadonnées arrivent, mais aucun fichier
        # n'est téléchargé avant le choix explicite (unpause).
        p.flags |= lt.torrent_flags.upload_mode
        p.flags &= ~lt.torrent_flags.auto_managed
        p.flags &= ~lt.torrent_flags.paused
        # Attention : p.trackers renvoie une COPIE. y ajouter avec append() ne
        # change rien (les trackers n'étaient jamais transmis) : il faut
        # réaffecter la liste complète.
        own = list(p.trackers)
        p.trackers = own + [t for t in self.trackers if t not in own]

        ih = str(p.ti.info_hashes().v1) if p.ti else str(p.info_hashes.v1)
        with self.lock:
            same = [it for it in self.items.values() if it["infoHash"] == ih and not it["removed"]]
            # Un torrent déjà terminé ne bloque pas un nouvel ajout (pour
            # récupérer d'autres fichiers du même torrent) : comme aria2, on le
            # libère, ses fichiers restent sur le disque.
            if same and all(it.get("complete") for it in same if it["kind"] == "main"):
                self.remove(same[0]["gid"])
                same = []
                # La suppression est asynchrone dans libtorrent : on attend
                # qu'elle soit effective avant de rajouter le même torrent.
                sha = lt.sha1_hash(bytes.fromhex(ih))
                deadline = time.time() + 10
                while self.ses.find_torrent(sha).is_valid() and time.time() < deadline:
                    time.sleep(0.1)
            if same:
                raise RpcError(f"InfoHash {ih} is already registered.")
            try:
                h = self.ses.add_torrent(p)
            except RuntimeError as e:
                if "already" in str(e).lower() or "duplicate" in str(e).lower():
                    raise RpcError(f"InfoHash {ih} is already registered.")
                raise
            meta, main = new_gid(), new_gid()
            name = p.name or (p.ti.name() if p.ti else "")
            base = {"handle": h, "infoHash": ih, "name": name, "removed": False,
                    "error": None, "created": time.time()}
            self.items[meta] = {**base, "gid": meta, "kind": "meta", "main": main}
            self.items[main] = {**base, "gid": main, "kind": "main", "meta": meta,
                                "started": False, "complete": False}
            return meta

    # ─── Statut au format aria2 ──────────────────────────────────────────
    def _get(self, gid: str) -> dict:
        it = self.items.get(str(gid))
        if not it:
            raise RpcError(f"GID {gid} is not found")
        return it

    def status(self, gid: str, keys: list | None = None) -> dict:
        with self.lock:
            it = self._get(gid)
        h = it["handle"]
        out = {"gid": it["gid"], "infoHash": it["infoHash"], "dir": self.save_dir,
               "bittorrent": {}, "files": []}
        if it["removed"] or not h.is_valid():
            out.update(status="removed", totalLength="0", completedLength="0")
            return _pick(out, keys)
        s = h.status()
        has_meta = s.has_metadata
        out["connections"] = str(s.num_peers)
        out["numSeeders"] = str(s.num_seeds)

        if it["kind"] == "meta":
            if it["error"]:
                out.update(status="error", errorMessage=it["error"], errorCode="1")
            elif has_meta:
                out.update(status="complete", followedBy=[it["main"]])
            else:
                out["status"] = "active"
            out.update(totalLength="0", completedLength="0", downloadSpeed="0", uploadSpeed="0")
            if it["name"]:
                out["bittorrent"] = {"info": {"name": it["name"]}}
            return _pick(out, keys)

        # Torrent proprement dit
        out["following"] = it["meta"]
        if not has_meta:
            out.update(status="waiting", totalLength="0", completedLength="0")
            return _pick(out, keys)
        ti = h.torrent_file()
        fs = ti.files()
        prios = h.get_file_priorities()
        progress = h.file_progress(lt.torrent_handle.piece_granularity)
        out["bittorrent"] = {"info": {"name": ti.name()}}
        out["files"] = [{
            "index": str(i + 1),
            "path": os.path.join(self.save_dir, fs.file_path(i)),
            "length": str(fs.file_size(i)),
            "completedLength": str(min(progress[i], fs.file_size(i))),
            "selected": "true" if prios[i] > 0 else "false",
        } for i in range(fs.num_files())]
        if it["error"]:
            status = "error"
            out.update(errorMessage=it["error"], errorCode="1")
        elif it["complete"]:
            status = "complete"
        elif not it["started"]:
            status = "paused"
        else:
            status = "active"
        # Tailles calculées sur les seuls fichiers choisis : total_wanted de
        # libtorrent compte des morceaux entiers, partagés avec les voisins.
        chosen = [f for f in out["files"] if f["selected"] == "true"]
        total = sum(int(f["length"]) for f in chosen)
        done = sum(int(f["completedLength"]) for f in chosen)
        out.update(status=status,
                   totalLength=str(total), completedLength=str(done),
                   downloadSpeed=str(s.download_payload_rate), uploadSpeed=str(s.upload_payload_rate),
                   uploadLength=str(s.all_time_upload))
        return _pick(out, keys)

    def listing(self, active: bool, keys: list | None) -> list:
        with self.lock:
            gids = [g for g, it in self.items.items() if not it["removed"]]
        out = []
        for g in gids:
            try:
                st = self.status(g, None)
            except RpcError:
                continue
            is_active = st["status"] == "active"
            is_waiting = st["status"] in ("waiting", "paused")
            if (active and is_active) or (not active and is_waiting):
                out.append(_pick(st, keys))
        return out

    # ─── Commandes ───────────────────────────────────────────────────────
    def select_files(self, gid: str, selection: str) -> None:
        with self.lock:
            it = self._get(gid)
        h = it["handle"]
        if not h.status().has_metadata:
            raise RpcError("Métadonnées pas encore reçues")
        wanted = {int(x) for x in str(selection).split(",") if x.strip().isdigit()}
        n = h.torrent_file().num_files()
        h.prioritize_files([4 if (i + 1) in wanted else 0 for i in range(n)])

    def unpause(self, gid: str) -> None:
        with self.lock:
            it = self._get(gid)
            it["started"] = True
            if it["kind"] == "main":
                self.items[it["meta"]]["started"] = True
        h = it["handle"]
        h.unset_flags(lt.torrent_flags.upload_mode)
        h.resume()

    def pause(self, gid: str) -> None:
        self._get(gid)["handle"].pause()

    def remove(self, gid: str) -> None:
        with self.lock:
            it = self._get(gid)
            if it["removed"]:
                return
            for other in self.items.values():
                if other["handle"] == it["handle"]:
                    other["removed"] = True
        try:
            self.ses.remove_torrent(it["handle"])
        except Exception:
            pass

    def forget(self, gid: str) -> None:
        with self.lock:
            it = self.items.get(str(gid))
            if it and it["removed"]:
                self.items.pop(str(gid), None)

    def change_global(self, opts: dict) -> None:
        if "bt-tracker" in opts:
            self.trackers = [t for t in str(opts["bt-tracker"]).split(",") if t.strip()]
            with self.lock:
                handles = {id(it["handle"]): it["handle"] for it in self.items.values() if not it["removed"]}
            for h in handles.values():
                for i, t in enumerate(self.trackers):
                    try:
                        h.add_tracker({"url": t, "tier": 10 + i})
                    except Exception:
                        pass
        if "seed-ratio" in opts:
            self.seed = str(opts["seed-ratio"]) not in ("0", "0.0", "")

    def shutdown(self) -> None:
        self.stopping = True
        self.save_state()
        threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()


def _pick(d: dict, keys: list | None) -> dict:
    return {k: d[k] for k in keys if k in d} if keys else d


def make_handler(engine: Engine, secret: str):
    def dispatch(method: str, params: list):
        if not params or params[0] != f"token:{secret}":
            raise RpcError("Unauthorized")
        p = params[1:]
        if method == "aria2.getVersion":
            return {"version": f"libtorrent {lt.__version__}", "enabledFeatures": ["BitTorrent", "uTP"]}
        if method == "aria2.addUri":
            return engine.add_uri(p[0], p[1] if len(p) > 1 else None)
        if method == "aria2.tellStatus":
            return engine.status(p[0], p[1] if len(p) > 1 else None)
        if method == "aria2.tellActive":
            return engine.listing(True, p[0] if p else None)
        if method == "aria2.tellWaiting":
            return engine.listing(False, p[2] if len(p) > 2 else None)
        if method == "aria2.changeOption":
            if "select-file" in p[1]:
                engine.select_files(p[0], p[1]["select-file"])
            return "OK"
        if method == "aria2.unpause":
            engine.unpause(p[0]); return p[0]
        if method in ("aria2.forcePause", "aria2.pause"):
            engine.pause(p[0]); return p[0]
        if method in ("aria2.forceRemove", "aria2.remove"):
            engine.remove(p[0]); return p[0]
        if method == "aria2.removeDownloadResult":
            engine.forget(p[0]); return "OK"
        if method == "aria2.changeGlobalOption":
            engine.change_global(p[0]); return "OK"
        if method in ("aria2.forceShutdown", "aria2.shutdown"):
            engine.shutdown(); return "OK"
        raise RpcError(f"Méthode non prise en charge : {method}")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            if self.path != "/jsonrpc" or self.client_address[0] not in ("127.0.0.1", "::1"):
                self.send_response(404); self.end_headers(); return
            n = int(self.headers.get("Content-Length") or 0)
            try:
                req = json.loads(self.rfile.read(min(n, 1_000_000)) or b"{}")
                result = {"jsonrpc": "2.0", "id": req.get("id"),
                          "result": dispatch(req.get("method", ""), req.get("params") or [])}
            except RpcError as e:
                result = {"jsonrpc": "2.0", "id": None, "error": {"code": 1, "message": str(e)}}
            except Exception as e:  # noqa: BLE001
                result = {"jsonrpc": "2.0", "id": None, "error": {"code": 1, "message": f"{type(e).__name__}: {e}"}}
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--secret", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    engine = Engine(a.dir, a.state, bool(a.seed))
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(engine, a.secret))
    print(f"libtorrent {lt.__version__} prêt sur 127.0.0.1:{a.port}", flush=True)
    try:
        srv.serve_forever()
    finally:
        engine.save_state()


if __name__ == "__main__":
    sys.exit(main())
