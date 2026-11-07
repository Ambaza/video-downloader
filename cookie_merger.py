#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cookie_merger.py — Fusionne les cookies de PLUSIEURS navigateurs (et de Tor)
en un seul fichier au format Netscape (cookies.txt) utilisable par yt-dlp.

Utilise directement le moteur d'extraction de yt-dlp (yt_dlp.cookies), ce qui
donne le meilleur support de déchiffrement possible, sans dépendance externe.

Usage:
    python cookie_merger.py OUTFILE [browser ...] [--tor PROFILE_DIR ...] [--firefox-profile DIR ...]

Exemple:
    python cookie_merger.py cookies.txt chrome edge brave firefox opera vivaldi \
        --tor "C:\\Users\\me\\Desktop\\Tor Browser\\Browser\\TorBrowser\\Data\\Browser\\profile.default"

Le script imprime sur stdout un résumé JSON: {"total": N, "sources": {...}, "errors": {...}}
Il retourne le code 0 dès qu'au moins un cookie a pu être récupéré, sinon 1.

Note importante: Chrome/Edge/Brave (v127+) utilisent l'App-Bound Encryption.
Leurs cookies ne peuvent pas être déchiffrés par un outil externe quand le
navigateur est ouvert (et souvent même fermé). Firefox et Tor restent lisibles
même ouverts. Le script ignore silencieusement les navigateurs qui échouent.
"""
import sys
import os
import json

# Liste par défaut si aucun navigateur n'est fourni en argument.
DEFAULT_BROWSERS = ["chrome", "edge", "brave", "firefox", "opera", "vivaldi", "chromium"]


class _QuietLogger:
    """Logger minimal attendu par yt_dlp.cookies (debug/info/warning/error)."""
    def __init__(self):
        self.messages = []

    def debug(self, msg):
        pass

    def info(self, msg):
        self.messages.append(str(msg))

    def warning(self, msg, *args, **kwargs):
        self.messages.append("WARNING: " + str(msg))

    def error(self, msg, *args, **kwargs):
        self.messages.append("ERROR: " + str(msg))


def _import_yt_dlp():
    try:
        from yt_dlp.cookies import extract_cookies_from_browser, YoutubeDLCookieJar
        return extract_cookies_from_browser, YoutubeDLCookieJar
    except Exception as e:
        print(json.dumps({"total": 0, "sources": {}, "errors": {"import": str(e)}}))
        sys.exit(2)


def _extract(extract_fn, browser_name, profile=None):
    """Retourne (jar, error_str). jar peut être None."""
    logger = _QuietLogger()
    try:
        jar = extract_fn(browser_name, profile=profile, logger=logger)
        return jar, None
    except TypeError:
        # Anciennes signatures sans keyword 'logger' / 'profile'
        try:
            jar = extract_fn(browser_name, profile, logger)
            return jar, None
        except Exception as e:
            return None, str(e)
    except Exception as e:
        return None, str(e)


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: cookie_merger.py OUTFILE [browser ...] [--tor DIR ...] [--firefox-profile DIR ...]",
              file=sys.stderr)
        sys.exit(64)

    outfile = args[0]
    rest = args[1:]

    browsers = []
    tor_profiles = []
    firefox_profiles = []

    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == "--tor":
            i += 1
            if i < len(rest):
                tor_profiles.append(rest[i])
        elif tok == "--firefox-profile":
            i += 1
            if i < len(rest):
                firefox_profiles.append(rest[i])
        else:
            browsers.append(tok)
        i += 1

    if not browsers:
        browsers = list(DEFAULT_BROWSERS)

    extract_fn, YoutubeDLCookieJar = _import_yt_dlp()

    merged = YoutubeDLCookieJar()
    sources = {}
    errors = {}

    def add_jar(label, jar):
        count = 0
        for cookie in jar:
            try:
                merged.set_cookie(cookie)
                count += 1
            except Exception:
                pass
        sources[label] = sources.get(label, 0) + count

    # Navigateurs standard
    for b in browsers:
        jar, err = _extract(extract_fn, b)
        if jar is not None:
            add_jar(b, jar)
        elif err:
            errors[b] = err[:300]

    # Profils Firefox explicites (au cas où plusieurs profils)
    for p in firefox_profiles:
        if not os.path.isdir(p):
            errors["firefox:" + p] = "profil introuvable"
            continue
        jar, err = _extract(extract_fn, "firefox", profile=p)
        if jar is not None:
            add_jar("firefox:" + os.path.basename(p), jar)
        elif err:
            errors["firefox:" + p] = err[:300]

    # Tor (moteur Firefox, profil pointé sur le dossier du profil Tor)
    for p in tor_profiles:
        if not os.path.isdir(p):
            errors["tor:" + p] = "profil introuvable"
            continue
        jar, err = _extract(extract_fn, "firefox", profile=p)
        if jar is not None:
            add_jar("tor", jar)
        elif err:
            errors["tor:" + p] = err[:300]

    total = sum(1 for _ in merged)

    if total > 0:
        try:
            merged.save(outfile, ignore_discard=True, ignore_expires=True)
        except Exception as e:
            print(json.dumps({"total": total, "sources": sources,
                              "errors": {**errors, "save": str(e)}}))
            sys.exit(3)

    print(json.dumps({"total": total, "sources": sources, "errors": errors}))
    sys.exit(0 if total > 0 else 1)


if __name__ == "__main__":
    main()
