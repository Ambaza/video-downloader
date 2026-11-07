// ─────────────────────────────────────────────────────────────
// Pont entre la page de l'application (http://localhost:3000) et
// l'extension. Permet au bouton « Synchroniser via l'extension »
// de l'app de déclencher l'envoi des cookies sans ouvrir le popup.
// ─────────────────────────────────────────────────────────────

// Signale à la page que l'extension est présente.
window.postMessage({ source: "vd-extension", type: "ready" }, "*");

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "vd-app" || data.action !== "sync") return;

  chrome.runtime.sendMessage({ action: "sync", domain: data.domain }, (resp) => {
    window.postMessage(
      { source: "vd-extension", type: "sync-result", result: resp || { ok: false, error: "no response" } },
      "*"
    );
  });
});
