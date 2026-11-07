const btn = document.getElementById("sync");
const statusEl = document.getElementById("status");
const domainInput = document.getElementById("domain");

// Pré-remplit avec le domaine de l'onglet actif (pratique pour cibler un site)
chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  try {
    const url = tabs[0] && tabs[0].url;
    if (url) {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host && !host.includes("localhost") && !host.startsWith("127.")) {
        domainInput.placeholder = "ex : " + host;
      }
    }
  } catch {}
});

btn.addEventListener("click", () => {
  btn.disabled = true;
  btn.textContent = "Envoi…";
  statusEl.className = "status";
  statusEl.textContent = "";

  const domain = domainInput.value.trim();
  chrome.runtime.sendMessage({ action: "sync", domain: domain || undefined }, (resp) => {
    btn.disabled = false;
    btn.textContent = "Synchroniser maintenant";
    if (resp && resp.ok) {
      statusEl.className = "status ok";
      statusEl.textContent = `✅ ${resp.count} cookies envoyés à l'application.`;
    } else {
      statusEl.className = "status err";
      statusEl.textContent = "❌ " + ((resp && resp.error) || "Échec. L'application est-elle démarrée ?");
    }
  });
});
