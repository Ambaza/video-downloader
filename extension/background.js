// ─────────────────────────────────────────────────────────────
// Video Downloader — Cookie Sync (service worker)
//
// Lit les cookies via l'API `chrome.cookies` du navigateur lui-même :
// aucun déchiffrement de la base SQLite n'est nécessaire, donc cela
// fonctionne même navigateur OUVERT et malgré l'App-Bound Encryption
// de Chrome/Edge (v127+). Inclut les cookies httpOnly (login, âge).
// ─────────────────────────────────────────────────────────────

const APP_ENDPOINTS = [
  "http://localhost:3000/api/browser-cookies",
  "http://127.0.0.1:3000/api/browser-cookies",
];

// Convertit une liste de cookies chrome.cookies en format Netscape (cookies.txt)
function toNetscape(cookies) {
  let out = "# Netscape HTTP Cookie File\n# Généré par l'extension Video Downloader\n\n";
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.session ? 0 : Math.round(c.expirationDate || 0);
    out += [domain, includeSub, path, secure, expiry, c.name, c.value].join("\t") + "\n";
  }
  return out;
}

// Récupère les cookies (tous, ou filtrés sur un domaine) et les envoie à l'app
async function syncCookies(domain) {
  let cookies = await chrome.cookies.getAll({});
  if (domain) {
    const d = domain.replace(/^\./, "").toLowerCase();
    cookies = cookies.filter((c) => {
      const cd = (c.domain || "").replace(/^\./, "").toLowerCase();
      return cd === d || cd.endsWith("." + d) || d.endsWith("." + cd);
    });
  }

  const body = toNetscape(cookies);

  let lastErr = null;
  for (const url of APP_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, count: cookies.length, saved: data.count };
      }
      lastErr = "HTTP " + res.status;
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, error: lastErr || "Application injoignable (démarrez-la sur http://localhost:3000).", count: cookies.length };
}

// Messages venant du popup ou du content script (page localhost:3000)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "sync") {
    syncCookies(msg.domain).then(sendResponse);
    return true; // réponse asynchrone
  }
});
