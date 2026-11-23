"""Vérifie le moteur libtorrent (bt_engine.py) de bout en bout, comme l'appli.

Nécessite le réseau. Télécharge uniquement l'affiche (46 Ko) du film libre
« Sintel » (Blender Foundation, Creative Commons), dans un dossier temporaire.

Usage, depuis le dossier de l'appli :
    .venv-btScriptspython.exe toolseck_bt_engine.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

PY = sys.executable
ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bt_engine.py")
PORT, SECRET = 47311, "essai-secret"
work = tempfile.mkdtemp()
dl, state = os.path.join(work, "dl"), os.path.join(work, "state")
proc = subprocess.Popen([PY, "-I", ENGINE, "--port", str(PORT), "--secret", SECRET, "--dir", dl, "--state", state],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def rpc(method, *params, token=SECRET):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": [f"token:{token}", *params]}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/jsonrpc", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(out["error"]["message"])
    return out["result"]


def ok(label, cond, detail=""):
    print(("OK   " if cond else "ECHEC") + f" {label} {detail}")
    if not cond:
        raise SystemExit(1)


try:
    for _ in range(50):
        try:
            v = rpc("aria2.getVersion"); break
        except Exception:
            time.sleep(0.2)
    ok("demarrage", "libtorrent" in v["version"], v["version"])
    try:
        rpc("aria2.getVersion", token="mauvais"); ok("jeton refuse", False)
    except RuntimeError as e:
        ok("jeton refuse", "Unauthorized" in str(e))

    magnet = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel"
    t0 = time.time()
    meta = rpc("aria2.addUri", [magnet], {"bt-stop-timeout": "270"})
    try:
        rpc("aria2.addUri", [magnet]); ok("doublon refuse", False)
    except RuntimeError as e:
        ok("doublon refuse", "already registered" in str(e))
    main = None
    while time.time() - t0 < 90:
        st = rpc("aria2.tellStatus", meta)
        if st.get("followedBy"):
            main = st["followedBy"][0]; break
        time.sleep(0.5)
    ok("metadonnees", bool(main), f"en {time.time() - t0:.1f} s")
    st = rpc("aria2.tellStatus", main)
    ok("torrent en pause avant choix", st["status"] == "paused", st["status"])
    ok("liste des fichiers", len(st["files"]) == 11, f"{len(st['files'])} fichiers, nom={st['bittorrent']['info']['name']}")
    ok("suivi du metadonnees", st.get("following") == meta)
    found = [s for s in rpc("aria2.tellWaiting", 0, 1000, ["gid", "infoHash", "following"]) if s.get("following")]
    ok("retrouve par infoHash", any(s["infoHash"] == "08ada5a7a6183aae1e09d831df6748d566095a10" for s in found))

    poster = next(f for f in st["files"] if f["path"].endswith("poster.jpg"))
    rpc("aria2.changeOption", main, {"select-file": poster["index"]})
    rpc("aria2.unpause", main)
    t1 = time.time()
    while time.time() - t1 < 120:
        st = rpc("aria2.tellStatus", main)
        if st["status"] in ("complete", "error"):
            break
        time.sleep(0.7)
    ok("telechargement termine", st["status"] == "complete", f"en {time.time() - t1:.1f} s, {st['completedLength']}/{st['totalLength']} octets")
    for root, ds, fs_ in os.walk(dl):
        for f in fs_: print("   disque:", os.path.relpath(os.path.join(root,f), dl), os.path.getsize(os.path.join(root,f)))
    path = poster["path"]
    ok("affiche recue en entier", os.path.getsize(path) == int(poster["length"]), f"{os.path.getsize(path)} octets")
    movie = next(f for f in st["files"] if f["path"].endswith(".mp4"))
    size = os.path.getsize(movie["path"]) if os.path.exists(movie["path"]) else 0
    time.sleep(2)
    ok("pas de fichier .parts restant", not any(f.endswith(".parts") for f in os.listdir(dl)), str(os.listdir(dl)))
    ok("taille = fichier choisi", int(st["totalLength"]) == int(poster["length"]), st["totalLength"])
    ok("film non choisi non telecharge", size < 10_000_000, f"{size} octets")
    rpc("aria2.forceRemove", main)
    ok("supprime", rpc("aria2.tellStatus", main)["status"] == "removed")
    print("TOUT EST BON")
finally:
    try:
        rpc("aria2.forceShutdown")
    except Exception:
        pass
    time.sleep(1)
    proc.kill()
