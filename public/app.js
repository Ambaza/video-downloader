// ═══════════════════════════════════════════════
// VIDEO DOWNLOADER — Frontend Logic (v3)
// ═══════════════════════════════════════════════

(function () {
    'use strict';

    // ─── DOM Helpers ────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ─── DOM Elements ───────────────────────────
    const urlInput = $('#urlInput');
    const btnFetch = $('#btnFetch');
    const btnPaste = $('#btnPaste');
    const btnDownload = $('#btnDownload');
    const btnOpenFolder = $('#btnOpenFolder');
    const btnOpenFolderComplete = $('#btnOpenFolderComplete');
    const btnDownloadAnother = $('#btnDownloadAnother');
    const btnRetry = $('#btnRetry');
    const btnRefreshHistory = $('#btnRefreshHistory');
    const btnSettings = $('#btnSettings');
    const btnCancel = $('#btnCancel');
    const statusBadge = $('#statusBadge');

    const inputSection = $('#inputSection');
    const loadingSection = $('#loadingSection');
    const videoSection = $('#videoSection');
    const progressSection = $('#progressSection');
    const completeSection = $('#completeSection');
    const errorSection = $('#errorSection');
    const historySection = $('#historySection');
    const setupSection = $('#setupSection');
    const settingsModal = $('#settingsModal');

    // ─── State ──────────────────────────────────
    let currentVideoInfo = null;
    let currentKind = 'video';   // 'video' | 'torrent' | 'file'
    let torrentFiles = [];       // fichiers du torrent courant
    let torrentFilter = 'tout';  // catégorie affichée dans la liste

    // Un magnet peut livrer n'importe quoi : vidéos, musique, livres,
    // archives, images disque, programmes. On nomme chaque famille.
    const CATEGORY_LABELS = {
        video: 'Vidéo', audio: 'Audio', image: 'Images', document: 'Documents',
        archive: 'Archives', disque: 'Images disque', logiciel: 'Programmes',
        soustitre: 'Sous-titres', donnees: 'Données', autre: 'Autres',
    };
    let selectedFormat = 'best';
    let currentDownloadId = null;
    let eventSource = null;
    // File d'attente (téléchargement d'une plage d'épisodes)
    let queue = [];
    let queueIndex = 0;
    let queueAborted = false;
    let lastCompletedName = '';

    // ─── Initialize ─────────────────────────────
    async function init() {
        createParticles();
        checkYtDlp();
        loadHistory();
        bindEvents();
    }

    // ─── Background Particles ───────────────────
    function createParticles() {
        const container = $('#particles');
        const colors = ['rgba(108, 99, 255, 0.3)', 'rgba(224, 64, 251, 0.2)', 'rgba(0, 229, 255, 0.2)'];

        for (let i = 0; i < 30; i++) {
            const p = document.createElement('div');
            p.className = 'particle';
            const size = Math.random() * 4 + 1;
            p.style.cssText = `
                width: ${size}px;
                height: ${size}px;
                left: ${Math.random() * 100}%;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                animation-duration: ${Math.random() * 20 + 15}s;
                animation-delay: ${Math.random() * 10}s;
            `;
            container.appendChild(p);
        }
    }

    // ─── Check yt-dlp ───────────────────────────
    async function checkYtDlp() {
        try {
            const res = await fetch('/api/check');
            const data = await res.json();

            if (data.installed) {
                statusBadge.className = 'status-badge online';
                statusBadge.querySelector('.status-text').textContent = `v${data.version}`;

                // Show cookie mode badge in header
                const cookieInfo = $('#cookieInfo');
                try {
                    const settingsRes = await fetch('/api/settings');
                    const settingsData = await settingsRes.json();
                    const mode = settingsData.cookieMode || 'none';
                    const browser = settingsData.browserChoice || 'chrome';
                    if (mode === 'browser') {
                        cookieInfo.textContent = `🍪 ${browser.charAt(0).toUpperCase() + browser.slice(1)}`;
                        cookieInfo.style.display = '';
                    } else if (mode === 'all') {
                        cookieInfo.textContent = '🍪 Tous + Tor';
                        cookieInfo.style.display = '';
                    } else if (mode === 'extension') {
                        cookieInfo.textContent = '🍪 Extension';
                        cookieInfo.style.display = '';
                    } else if (mode === 'file' && settingsData.hasCookieFile) {
                        cookieInfo.textContent = '🍪 cookies.txt';
                        cookieInfo.style.display = '';
                    } else {
                        cookieInfo.style.display = 'none';
                    }
                } catch {
                    cookieInfo.style.display = 'none';
                }

                setupSection.classList.add('hidden');
                inputSection.classList.remove('hidden');
            } else {
                statusBadge.className = 'status-badge offline';
                statusBadge.querySelector('.status-text').textContent = 'Not found';
                setupSection.classList.remove('hidden');
            }
        } catch (e) {
            statusBadge.className = 'status-badge offline';
            statusBadge.querySelector('.status-text').textContent = 'Error';
        }
    }

    // ─── Event Bindings ─────────────────────────
    function bindEvents() {
        btnFetch.addEventListener('click', fetchVideoInfo);
        btnPaste.addEventListener('click', pasteFromClipboard);
        btnDownload.addEventListener('click', startDownload);
        btnOpenFolder.addEventListener('click', openFolder);
        btnOpenFolderComplete.addEventListener('click', openFolder);
        btnDownloadAnother.addEventListener('click', resetToInput);
        btnRetry.addEventListener('click', resetToInput);
        btnRefreshHistory.addEventListener('click', loadHistory);

        if (btnSettings) {
            btnSettings.addEventListener('click', openSettings);
        }

        const closeSettings = $('#closeSettings');
        if (closeSettings) {
            closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
        }

        if (settingsModal) {
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal) settingsModal.classList.add('hidden');
            });
        }

        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') fetchVideoInfo();
        });

        urlInput.addEventListener('paste', () => {
            setTimeout(() => {
                const v = urlInput.value.trim();
                if (v && isValidUrl(v)) fetchVideoInfo();
            }, 100);
        });

        // Cookie mode radio cards
        const cookieModeCards = $$('.cookie-mode-card');
        cookieModeCards.forEach(card => {
            card.addEventListener('click', async () => {
                const mode = card.dataset.mode;
                const radio = card.querySelector('input[type="radio"]');
                radio.checked = true;

                // Update card selection visuals
                cookieModeCards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');

                // Save to server
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookieMode: mode })
                });

                updateCookieModeUI(mode);
                checkYtDlp();
            });
        });

        // Browser select change
        const browserSelect = $('#browserSelect');
        if (browserSelect) {
            browserSelect.addEventListener('change', async () => {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ browserChoice: browserSelect.value })
                });
                showToast(`Navigateur: ${browserSelect.options[browserSelect.selectedIndex].text}`, 'success');
                checkYtDlp();
            });
        }

        // Test cookies button
        const btnTestCookies = $('#btnTestCookies');
        if (btnTestCookies) {
            btnTestCookies.addEventListener('click', testCookies);
        }

        // Sync cookies via extension button
        const btnSyncExt = $('#btnSyncExt');
        if (btnSyncExt) {
            btnSyncExt.addEventListener('click', syncViaExtension);
        }

        // Import d'un cookies.txt — ces deux liaisons manquaient : le bouton
        // et le champ fichier existaient dans le HTML mais n'étaient reliés
        // à rien, la fonctionnalité était donc totalement inopérante.
        const btnUploadCookie = $('#btnUploadCookie');
        const cookieFileInput = $('#cookieFileInput');
        if (btnUploadCookie && cookieFileInput) {
            btnUploadCookie.addEventListener('click', () => cookieFileInput.click());
            cookieFileInput.addEventListener('change', uploadCookieFile);
        }

        // Annulation d'un téléchargement en cours
        if (btnCancel) btnCancel.addEventListener('click', cancelDownload);

        // Réglages : vitesse, anti-blocage, options de fichier
        const fragRange = $('#fragRange');
        const fragValue = $('#fragValue');
        if (fragRange && fragValue) {
            fragRange.addEventListener('input', () => { fragValue.textContent = fragRange.value; });
            fragRange.addEventListener('change', () => {
                saveSetting({ concurrentFragments: parseInt(fragRange.value, 10) },
                    `Fragments parallèles : ${fragRange.value}`);
            });
        }

        const impersonateSelect = $('#impersonateSelect');
        if (impersonateSelect) {
            impersonateSelect.addEventListener('change', () => {
                saveSetting({ impersonate: impersonateSelect.value }, 'Anti-blocage mis à jour');
            });
        }

        const toggles = [
            ['#optMetadata', 'embedMetadata', 'Métadonnées'],
            ['#optThumbnail', 'embedThumbnail', 'Miniature incrustée'],
            ['#optSubs', 'embedSubs', 'Sous-titres incrustés'],
            ['#optInsecureTLS', 'insecureTLS', 'Vérification TLS'],
        ];
        for (const [sel, key, label] of toggles) {
            const el = $(sel);
            if (!el) continue;
            el.addEventListener('change', () => {
                saveSetting({ [key]: el.checked }, `${label} : ${el.checked ? 'activé' : 'désactivé'}`);
            });
        }

        // Torrent : tout sélectionner / tout désélectionner
        // Agit sur les fichiers AFFICHÉS : avec un filtre actif, « Tout »
        // sélectionne cette seule famille — c'est ce qu'on veut quand on
        // cherche juste les PDF d'un torrent qui en contient quatre-vingts.
        const setAllFiles = (checked) => {
            for (const f of torrentFiles) {
                if (torrentFilter === 'tout' || f.category === torrentFilter) f.selected = checked;
            }
            renderTorrentFileRows();
            updateTorrentSummary();
        };
        const bAll = $('#btnSelectAll'), bNone = $('#btnSelectNone');
        if (bAll) bAll.addEventListener('click', (e) => { e.preventDefault(); setAllFiles(true); });
        if (bNone) bNone.addEventListener('click', (e) => { e.preventDefault(); setAllFiles(false); });

        const optSeed = $('#optSeed');
        if (optSeed) {
            optSeed.addEventListener('change', () => {
                saveSetting({ seedAfterDownload: optSeed.checked },
                    optSeed.checked ? 'Partage après téléchargement activé' : 'Partage arrêté à la fin');
            });
        }

        // Anime-Sama : bascule du mode lot
        const asBatchToggle = $('#asBatchToggle');
        if (asBatchToggle) {
            asBatchToggle.addEventListener('change', () => {
                const range = $('#asBatchRange');
                if (range) range.classList.toggle('hidden', !asBatchToggle.checked);
            });
        }

        // Échap ferme la fenêtre de réglages
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && settingsModal && !settingsModal.classList.contains('hidden')) {
                settingsModal.classList.add('hidden');
            }
        });
    }

    // ─── Enregistre un réglage côté serveur ─────
    async function saveSetting(patch, successMessage) {
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                showToast('Réglage refusé : ' + (data.error || res.status), 'error');
                return false;
            }
            if (successMessage) showToast(successMessage, 'success');
            return true;
        } catch {
            showToast('Serveur injoignable', 'error');
            return false;
        }
    }

    // ─── Upload Cookie File ─────────────────────
    async function uploadCookieFile(e) {
        const file = e.target.files[0];
        if (!file) return;

        const text = await file.text();

        try {
            const res = await fetch('/api/upload-cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: text
            });
            const data = await res.json();

            if (data.success) {
                showToast(`Cookies importés (${data.count || '?'}) 🍪`, 'success');
                const cookieStatus = $('#cookieStatus');
                if (cookieStatus) {
                    cookieStatus.textContent = '✅ cookies.txt chargé';
                    cookieStatus.className = 'cookie-status active';
                }
                checkYtDlp();
            } else {
                showToast('Erreur : ' + (data.error || 'Erreur inconnue'), 'error');
            }
        } catch {
            showToast('Erreur d\'upload', 'error');
        }

        e.target.value = '';
    }

    // ─── Update Cookie Mode UI ─────────────────
    function updateCookieModeUI(mode) {
        const browserGroup = $('#browserSelectGroup');
        const testGroup = $('#testCookieGroup');
        const fileGroup = $('#fileUploadGroup');
        const allGroup = $('#allModeGroup');
        const testResult = $('#testResult');

        if (testResult) {
            testResult.classList.add('hidden');
            testResult.className = 'test-result hidden';
        }

        const extGroup = $('#extModeGroup');
        const show = (el, visible) => { if (el) el.classList.toggle('hidden', !visible); };

        if (mode === 'browser') {
            show(browserGroup, true); show(testGroup, true); show(fileGroup, false); show(allGroup, false); show(extGroup, false);
        } else if (mode === 'all') {
            show(browserGroup, false); show(testGroup, true); show(fileGroup, false); show(allGroup, true); show(extGroup, false);
            loadTorStatus();
        } else if (mode === 'extension') {
            show(browserGroup, false); show(testGroup, true); show(fileGroup, false); show(allGroup, false); show(extGroup, true);
            refreshExtStatus();
        } else if (mode === 'file') {
            show(browserGroup, false); show(testGroup, true); show(fileGroup, true); show(allGroup, false); show(extGroup, false);
        } else {
            show(browserGroup, false); show(testGroup, false); show(fileGroup, false); show(allGroup, false); show(extGroup, false);
        }
    }

    // ─── Extension detection + sync bridge ──────
    let extensionPresent = false;
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== 'vd-extension') return;
        if (d.type === 'ready') {
            extensionPresent = true;
            refreshExtStatus();
        } else if (d.type === 'sync-result') {
            const r = d.result || {};
            if (r.ok) showToast(`✅ ${r.count} cookies synchronisés depuis le navigateur`, 'success');
            else showToast('❌ ' + (r.error || 'Échec de la synchronisation'), 'error');
        }
    });

    function refreshExtStatus() {
        const el = $('#extStatus');
        if (!el) return;
        el.innerHTML = extensionPresent
            ? '🔌 Extension détectée ✅'
            : "🔌 Extension non détectée — installez-la depuis le dossier <code>extension/</code>, puis rechargez cette page.";
    }

    function syncViaExtension() {
        if (!extensionPresent) {
            showToast("Extension non détectée. Installez-la (dossier extension/) puis rechargez la page.", 'warning');
            return;
        }
        window.postMessage({ source: 'vd-app', action: 'sync' }, '*');
        showToast('Synchronisation en cours…', 'info');
    }

    // ─── Load Tor detection status ──────────────
    async function loadTorStatus() {
        const el = $('#torStatus');
        if (!el) return;
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            const profiles = data.torProfiles || [];
            if (!data.pythonAvailable) {
                el.innerHTML = '❌ Python introuvable — requis pour la fusion multi-navigateurs (installé avec yt-dlp via pip).';
            } else if (profiles.length) {
                el.innerHTML = `🧅 Tor détecté : ${profiles.length} profil(s) ✅`;
            } else {
                el.innerHTML = '🧅 Tor : aucun profil détecté (ouvrez Tor au moins une fois, ou renseignez le chemin).';
            }
        } catch {
            el.textContent = '🧅 Tor : statut indisponible.';
        }
    }

    // ─── Test Cookies ────────────────────────
    async function testCookies() {
        const btn = $('#btnTestCookies');
        const result = $('#testResult');
        if (!btn || !result) return;

        btn.classList.add('testing');
        btn.querySelector('span').textContent = 'Test en cours';
        result.classList.add('hidden');
        result.className = 'test-result hidden';

        try {
            const res = await fetch('/api/test-cookies');
            const data = await res.json();

            result.classList.remove('hidden');
            if (data.success) {
                result.className = 'test-result success';
                result.textContent = data.message;
            } else {
                result.className = 'test-result error';
                result.textContent = '❌ ' + data.message;
            }
        } catch {
            result.classList.remove('hidden');
            result.className = 'test-result error';
            result.textContent = '❌ Erreur de connexion au serveur.';
        }

        btn.classList.remove('testing');
        btn.querySelector('span').textContent = 'Tester les cookies';
    }

    // ─── Open Settings ───────────────────────
    async function openSettings() {
        if (!settingsModal) return;
        settingsModal.classList.remove('hidden');

        try {
            // Load current settings
            const res = await fetch('/api/settings');
            const data = await res.json();

            // Set active cookie mode card
            const mode = data.cookieMode || 'none';
            const cookieModeCards = $$('.cookie-mode-card');
            cookieModeCards.forEach(card => {
                const isActive = card.dataset.mode === mode;
                card.classList.toggle('selected', isActive);
                card.querySelector('input[type="radio"]').checked = isActive;
            });

            // Update conditional sections visibility
            updateCookieModeUI(mode);

            // Populate browser dropdown from detection
            const browserSelect = $('#browserSelect');
            if (browserSelect) {
                try {
                    const browsersRes = await fetch('/api/detect-browsers');
                    const browsers = await browsersRes.json();
                    browserSelect.innerHTML = browsers.map(b =>
                        `<option value="${b.id}">${b.name}</option>`
                    ).join('');
                } catch { }
                browserSelect.value = data.browserChoice || 'chrome';
            }

            // Cookie file status
            const cookieStatus = $('#cookieStatus');
            if (cookieStatus) {
                if (data.hasCookieFile) {
                    cookieStatus.textContent = '✅ cookies.txt chargé';
                    cookieStatus.className = 'cookie-status active';
                } else {
                    cookieStatus.textContent = '⚠️ Aucun fichier cookies uploadé';
                    cookieStatus.className = 'cookie-status inactive';
                }
            }

            const dirEl = $('#downloadsDir');
            if (dirEl) dirEl.textContent = data.downloadsDir || 'Inconnu';

            // Avertissement anti-blocage (impersonation TLS) si curl_cffi absent
            const impWarn = $('#impersonateWarn');
            if (impWarn) impWarn.classList.toggle('hidden', !!data.impersonateAvailable);

            // Vitesse
            const fragRange = $('#fragRange');
            const fragValue = $('#fragValue');
            if (fragRange && fragValue) {
                fragRange.value = data.concurrentFragments || 8;
                fragValue.textContent = fragRange.value;
            }

            // Cibles d'impersonation réellement disponibles
            const impSelect = $('#impersonateSelect');
            const impStatus = $('#impersonateStatus');
            if (impSelect) {
                const targets = data.impersonateTargets || [];
                impSelect.innerHTML =
                    '<option value="auto">Automatique (recommandé)</option>' +
                    '<option value="off">Désactivé</option>' +
                    targets.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
                impSelect.value = data.impersonate || 'auto';
                impSelect.disabled = targets.length === 0;
                if (impStatus) {
                    impStatus.textContent = targets.length
                        ? `✅ Navigateurs imitables : ${targets.join(', ')}`
                        : '❌ curl_cffi absent — installez-le puis redémarrez l\'application.';
                }
            }

            // Moteur torrent
            const aria2El = $('#aria2Status');
            if (aria2El) {
                if (data.aria2Ready) {
                    aria2El.textContent = `✅ aria2 ${data.aria2Version} actif — liens magnet, .torrent et fichiers directs pris en charge.`;
                } else if (!data.aria2Available) {
                    aria2El.innerHTML = '❌ aria2 non installé — les liens magnet ne fonctionneront pas. Installez-le : <code>winget install aria2.aria2</code>';
                } else {
                    aria2El.textContent = '⚠️ aria2 installé mais non démarré : ' + (data.aria2Error || 'raison inconnue');
                }
            }

            // Options de contenu
            const setCheck = (sel, val) => { const el = $(sel); if (el) el.checked = !!val; };
            setCheck('#optSeed', data.seedAfterDownload);
            setCheck('#optMetadata', data.embedMetadata);
            setCheck('#optThumbnail', data.embedThumbnail);
            setCheck('#optSubs', data.embedSubs);
            setCheck('#optInsecureTLS', data.insecureTLS);

        } catch {
            showToast('Failed to load settings', 'error');
        }
    }

    // ─── Paste from Clipboard ───────────────────
    async function pasteFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            urlInput.value = text;
            urlInput.focus();
            if (isValidUrl(text)) {
                fetchVideoInfo();
            }
        } catch {
            showToast('Could not access clipboard', 'warning');
        }
    }

    // ─── Validate URL ───────────────────────────
    function isMagnet(str) {
        return typeof str === 'string' && str.trim().toLowerCase().startsWith('magnet:?');
    }

    function isValidUrl(str) {
        // Un magnet n'a ni hôte ni chemin : new URL() ne le valide pas
        // comme une adresse ordinaire, on le reconnaît séparément.
        if (isMagnet(str)) {
            // Même règle que le serveur : btih = 40 caractères hexadécimaux
            // ou 32 en base32. Sans ça, « magnet:?xt=urn:btih:xyz » partait
            // au serveur pour revenir en écran d'erreur.
            const m = /xt=urn:btih:([^&]+)/i.exec(str);
            if (m) {
                const h = decodeURIComponent(m[1]);
                return /^[0-9a-f]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
            }
            return /xt=urn:btmh:1220[0-9a-f]{64}/i.test(str);
        }
        try {
            const u = new URL(str);
            return ['http:', 'https:', 'ftp:', 'sftp:'].includes(u.protocol);
        } catch {
            return false;
        }
    }

    // ─── Fetch Video Info ───────────────────────
    async function fetchVideoInfo() {
        const url = urlInput.value.trim();
        if (!url) {
            showToast('Please enter a URL', 'warning');
            urlInput.focus();
            return;
        }

        if (!isValidUrl(url)) {
            showToast('Lien invalide : une adresse http(s), ftp ou un lien magnet est attendu.', 'warning');
            urlInput.focus();
            return;
        }

        showSection('loading');
        if (isMagnet(url)) {
            $('#loadingText') && ($('#loadingText').textContent = 'Recherche de pairs… (jusqu\'à 4 minutes pour un torrent peu partagé)');
        }

        try {
            const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error + (data.details ? '\n\n' + data.details : ''));
            }

            currentVideoInfo = data;
            renderVideoInfo(data);
            showSection('video');
        } catch (e) {
            showError(e.message || 'Failed to fetch video info');
        }
    }

    // ─── Render Video Info ──────────────────────
    function renderVideoInfo(info) {
        currentKind = info.kind || 'video';

        if (currentKind === 'torrent') return renderTorrentInfo(info);
        if (currentKind === 'file') return renderDirectFileInfo(info);

        // Vidéo : on repart d'un état propre
        $('#torrentSection').classList.add('hidden');
        $('#directSection').classList.add('hidden');
        btnDownload.disabled = false;
        btnDownload.querySelector('span').textContent = 'Download Video';

        const thumb = $('#videoThumbnail');
        if (info.thumbnail) {
            showPreview(true);
            thumb.src = info.thumbnail;
            thumb.alt = info.title || '';
            thumb.style.display = '';
            // Miniature injoignable : on replie tout le bloc plutôt que de
            // laisser un rectangle noir au format 16/9.
            thumb.onerror = () => showPreview(false);
        } else {
            showPreview(false);
        }

        const dur = $('#videoDuration');
        if (info.duration_string) {
            dur.textContent = info.duration_string;
            dur.style.display = '';
        } else {
            dur.style.display = 'none';
        }

        $('#videoTitle').textContent = info.title || 'Untitled Video';
        $('#videoUploader span').textContent = info.uploader || (info.isAnimeSama ? 'Anime-Sama' : 'Unknown');
        $('#videoViews span').textContent = info.view_count ? formatNumber(info.view_count) + ' views' : '—';
        $('#videoSource span').textContent = info.extractor || (info.isAnimeSama ? 'Catalogue' : '—');

        const grid = $('#qualityGrid');
        const asSection = $('#asSection');
        const qualitySection = $('#qualitySection');
        
        grid.innerHTML = '';
        
        if (info.isAnimeSama) {
            asSection.classList.remove('hidden');
            qualitySection.classList.add('hidden');
            renderAnimeSamaControls(info.asData);
        } else {
            asSection.classList.add('hidden');
            qualitySection.classList.remove('hidden');

            for (const preset of info.presets) {
                const opt = document.createElement('div');
                opt.className = 'quality-option' + (preset.id === 'best' ? ' selected' : '');
                opt.dataset.format = preset.id;
                opt.innerHTML = `
                    <span class="quality-label">${preset.label}</span>
                    <span class="quality-desc">${preset.description}</span>
                `;
                opt.addEventListener('click', () => {
                    $$('.quality-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    selectedFormat = preset.id;
                });
                grid.appendChild(opt);
            }
        }

        selectedFormat = 'best';
    }

    // Replie ou déplie le bloc d'aperçu (ratio 16/9 réservé en CSS).
    function showPreview(visible) {
        const box = document.querySelector('.video-preview');
        if (box) box.style.display = visible ? '' : 'none';
        const dur = $('#videoDuration');
        if (dur && !visible) dur.style.display = 'none';
    }

    // ─── Vue torrent : liste des fichiers ───────
    function renderTorrentInfo(info) {
        torrentFiles = info.files || [];

        $('#torrentSection').classList.remove('hidden');
        $('#directSection').classList.add('hidden');
        $('#qualitySection').classList.add('hidden');
        $('#asSection').classList.add('hidden');

        showPreview(false);
        $('#videoTitle').textContent = info.title || 'Torrent';
        $('#videoUploader span').textContent = 'BitTorrent';
        $('#videoViews span').textContent = info.totalSizeLabel || '—';
        $('#videoSource span').textContent = (info.infoHash || '').slice(0, 12) + '…';

        // Un .torrent nomme ses fichiers librement : on prévient si l'un
        // d'eux tentait de sortir du dossier de téléchargement.
        const warn = $('#torrentWarning');
        if (info.hasSuspiciousPaths) {
            warn.classList.remove('hidden');
            warn.textContent = '⚠️ Ce torrent contient des chemins de fichiers anormaux (tentative de sortie du dossier de téléchargement). Ils sont neutralisés, mais la source est douteuse.';
        } else {
            warn.classList.add('hidden');
        }

        // Un torrent peut contenir des programmes : on le dit clairement,
        // sans rien bloquer — c'est par là qu'arrivent les mauvaises surprises.
        const execWarn = $('#torrentExecWarning');
        if (info.executableCount > 0) {
            execWarn.classList.remove('hidden');
            execWarn.textContent = info.executableCount === 1
                ? '⚠️ Ce torrent contient 1 programme exécutable. Faites-le analyser par un antivirus avant de l\'ouvrir.'
                : `⚠️ Ce torrent contient ${info.executableCount} programmes exécutables. Faites-les analyser par un antivirus avant de les ouvrir.`;
        } else {
            execWarn.classList.add('hidden');
        }

        torrentFilter = 'tout';
        renderTorrentFilters();
        renderTorrentFileRows();
        updateTorrentSummary();
    }

    // Puces de filtrage, une par famille réellement présente.
    function renderTorrentFilters() {
        const box = $('#torrentFilters');
        box.innerHTML = '';
        if (torrentFiles.length < 2) return;

        const counts = {};
        for (const f of torrentFiles) counts[f.category] = (counts[f.category] || 0) + 1;

        const entries = [['tout', 'Tout', torrentFiles.length]]
            .concat(Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([c, n]) => [c, CATEGORY_LABELS[c] || c, n]));

        // Une seule famille : le filtre n'apporte rien.
        if (entries.length <= 2) return;

        for (const [cat, label, n] of entries) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'filter-chip' + (cat === torrentFilter ? ' active' : '');
            chip.dataset.cat = cat;
            chip.textContent = `${label} ${n}`;
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                torrentFilter = cat;
                renderTorrentFilters();
                renderTorrentFileRows();
                updateTorrentSummary();
            });
            box.appendChild(chip);
        }
    }

    // Les lignes de fichiers. On garde l'état coché dans torrentFiles pour
    // qu'il survive à un changement de filtre.
    function renderTorrentFileRows() {
        const list = $('#torrentFiles');
        list.innerHTML = '';
        const visible = torrentFiles.filter(f => torrentFilter === 'tout' || f.category === torrentFilter);

        for (const f of visible) {
            const row = document.createElement('label');
            row.className = 'torrent-file';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = f.selected !== false;
            cb.dataset.index = f.index;
            cb.addEventListener('change', () => {
                f.selected = cb.checked;
                updateTorrentSummary();
            });

            const pill = document.createElement('span');
            pill.className = 'ext-pill cat-' + f.category;
            pill.textContent = (f.ext || '—').toUpperCase().slice(0, 5);

            const name = document.createElement('span');
            name.className = 'torrent-file-name';
            name.textContent = f.name;          // textContent : nom jamais interprété
            name.title = f.name;

            const size = document.createElement('span');
            size.className = 'torrent-file-size';
            size.textContent = f.sizeLabel;

            row.append(cb, pill, name, size);
            if (f.suspicious) row.classList.add('suspicious');
            if (f.executable) row.classList.add('executable');
            list.appendChild(row);
        }

        if (!visible.length) {
            const empty = document.createElement('div');
            empty.className = 'torrent-empty';
            empty.textContent = 'Aucun fichier dans cette catégorie.';
            list.appendChild(empty);
        }
    }

    function selectedTorrentIndexes() {
        // On lit torrentFiles et non le DOM : un filtre actif masque des
        // lignes, mais leur sélection doit être conservée.
        return torrentFiles.filter(f => f.selected !== false).map(f => f.index);
    }

    function updateTorrentSummary() {
        const picked = selectedTorrentIndexes();
        const bytes = torrentFiles
            .filter(f => f.selected !== false)
            .reduce((n, f) => n + (f.size || 0), 0);
        const filterNote = torrentFilter !== 'tout'
            ? ` · filtre : ${CATEGORY_LABELS[torrentFilter] || torrentFilter}`
            : '';
        $('#torrentSummary').textContent =
            `${picked.length} fichier${picked.length > 1 ? 's' : ''} sur ${torrentFiles.length} — ${formatSize(bytes)}${filterNote}`;
        btnDownload.disabled = picked.length === 0;
        btnDownload.querySelector('span').textContent =
            picked.length === 0 ? 'Sélectionnez au moins un fichier' : 'Télécharger';
    }

    // ─── Vue fichier direct ─────────────────────
    function renderDirectFileInfo(info) {
        $('#directSection').classList.remove('hidden');
        $('#torrentSection').classList.add('hidden');
        $('#qualitySection').classList.add('hidden');
        $('#asSection').classList.add('hidden');

        showPreview(false);
        $('#videoTitle').textContent = info.title || 'Fichier';
        $('#videoUploader span').textContent = 'Téléchargement direct';
        $('#videoViews span').textContent = info.totalSizeLabel || '—';
        $('#videoSource span').textContent = info.mimeType || '—';

        const card = $('#directCard');
        card.innerHTML = '';
        const rows = [
            ['Nom', info.title],
            ['Taille', info.totalSizeLabel],
            ['Type', info.mimeType || 'inconnu'],
        ];
        for (const [k, v] of rows) {
            const r = document.createElement('div');
            r.className = 'direct-row';
            const a = document.createElement('span'); a.className = 'direct-key'; a.textContent = k;
            const b = document.createElement('span'); b.className = 'direct-val'; b.textContent = v || '—';
            r.append(a, b);
            card.appendChild(r);
        }
        btnDownload.disabled = false;
        btnDownload.querySelector('span').textContent = 'Télécharger le fichier';
    }

    // ─── Anime-Sama Controls ────────────────────
    function renderAnimeSamaControls(data) {
        const pSelect = $('#asPlayerSelect');
        const eSelect = $('#asEpisodeSelect');

        pSelect.innerHTML = data.players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        
        const updateEpisodes = () => {
            const player = data.players.find(p => p.id === pSelect.value);
            if (!player) return;
            eSelect.innerHTML = player.links.map((_, i) => `<option value="${i}">Épisode ${i + 1}</option>`).join('');
            // Borne la plage du mode lot sur le nombre réel d'épisodes
            const from = $('#asBatchFrom');
            const to = $('#asBatchTo');
            if (from && to) {
                from.max = player.links.length;
                to.max = player.links.length;
                from.value = 1;
                to.value = player.links.length;
            }
        };

        pSelect.onchange = updateEpisodes;
        updateEpisodes();

        // Initial fetch for first episode
        setTimeout(() => fetchAnimeSamaEpisodeInfo(), 100);
        
        eSelect.onchange = fetchAnimeSamaEpisodeInfo;
    }

    async function fetchAnimeSamaEpisodeInfo() {
        if (!currentVideoInfo || !currentVideoInfo.isAnimeSama) return;
        
        const pId = $('#asPlayerSelect').value;
        const eIdx = parseInt($('#asEpisodeSelect').value);
        const player = currentVideoInfo.asData.players.find(p => p.id === pId);
        const videoUrl = player.links[eIdx];

        if (!videoUrl) return;

        showToast('Loading episode info...', 'info');
        
        try {
            const res = await fetch(`/api/info?url=${encodeURIComponent(videoUrl)}`);
            const data = await res.json();
            
            if (res.ok) {
                // Update specific video info without re-rendering everything
                // We keep currentVideoInfo as the Anime-Sama container, but we'll use the episode URL for download
                $('#videoTitle').textContent = `[EP ${eIdx + 1}] ${currentVideoInfo.title} - ${data.title}`;
                if (data.thumbnail) $('#videoThumbnail').src = data.thumbnail;
                
                // Show qualities for this specific episode
                const grid = $('#qualityGrid');
                const qualitySection = $('#qualitySection');
                qualitySection.classList.remove('hidden');
                grid.innerHTML = '';
                
                for (const preset of data.presets) {
                    const opt = document.createElement('div');
                    opt.className = 'quality-option' + (preset.id === 'best' ? ' selected' : '');
                    opt.dataset.format = preset.id;
                    opt.innerHTML = `
                        <span class="quality-label">${preset.label}</span>
                        <span class="quality-desc">${preset.description}</span>
                    `;
                    opt.addEventListener('click', () => {
                        $$('.quality-option').forEach(o => o.classList.remove('selected'));
                        opt.classList.add('selected');
                        selectedFormat = preset.id;
                    });
                    grid.appendChild(opt);
                }
                
                // Track the actual video URL for download
                currentVideoInfo.activeEpisodeUrl = videoUrl;
            }
        } catch (e) {
            console.error('Failed to fetch episode info', e);
        }
    }

    // ─── Start Download ─────────────────────────
    // Construit la liste des URL à télécharger (une seule, ou une plage
    // d'épisodes Anime-Sama) puis les enchaîne séquentiellement.
    function startDownload() {
        queueAborted = false;
        queueIndex = 0;
        queue = buildDownloadQueue();

        if (!queue.length) {
            showToast('Aucune vidéo à télécharger', 'warning');
            return;
        }
        showSection('progress');
        runQueueItem();
    }

    function buildDownloadQueue() {
        // Torrent : le serveur a déjà le torrent en pause, on lui renvoie
        // son identifiant et la liste des fichiers retenus.
        if (currentKind === 'torrent') {
            const picked = selectedTorrentIndexes();
            if (!picked.length) return [];
            return [{
                params: { gid: currentVideoInfo.gid, files: picked.join(',') },
                label: currentVideoInfo.title || 'Torrent',
            }];
        }

        // Fichier direct : confié au moteur aria2 plutôt qu'à yt-dlp.
        if (currentKind === 'file') {
            return [{
                params: { url: currentVideoInfo.url, direct: '1' },
                label: currentVideoInfo.title || 'Fichier',
            }];
        }

        const isAS = currentVideoInfo && currentVideoInfo.isAnimeSama;
        if (!isAS) {
            const url = urlInput.value.trim();
            return url ? [{ params: { url, format: selectedFormat }, label: '' }] : [];
        }

        const pSelect = $('#asPlayerSelect');
        const player = currentVideoInfo.asData.players.find(p => p.id === pSelect.value);
        if (!player) return [];

        const batch = $('#asBatchToggle');
        if (batch && batch.checked) {
            const total = player.links.length;
            let from = parseInt($('#asBatchFrom').value, 10) || 1;
            let to = parseInt($('#asBatchTo').value, 10) || from;
            from = Math.min(Math.max(1, from), total);
            to = Math.min(Math.max(from, to), total);
            const items = [];
            for (let n = from; n <= to; n++) {
                items.push({
                    params: { url: player.links[n - 1], format: selectedFormat },
                    label: `Épisode ${n}`,
                });
            }
            return items;
        }

        const idx = parseInt($('#asEpisodeSelect').value, 10) || 0;
        const url = currentVideoInfo.activeEpisodeUrl || player.links[idx];
        return url ? [{ params: { url, format: selectedFormat }, label: `Épisode ${idx + 1}` }] : [];
    }

    function updateQueueBadge() {
        const el = $('#progressQueue');
        if (!el) return;
        if (queue.length <= 1) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.textContent = `Élément ${queueIndex + 1} / ${queue.length} — ${queue[queueIndex].label || ''}`;
    }

    function runQueueItem() {
        if (queueAborted || queueIndex >= queue.length) return;
        const item = queue[queueIndex];

        $('#progressFilename').textContent = item.label || 'Téléchargement…';
        $('#progressPercent').textContent = '0%';
        $('#progressBar').style.width = '0%';
        $('#progressSpeed').textContent = '—';
        $('#progressEta').textContent = '—';
        $('#progressSize').textContent = '—';
        $('#progressStatus').textContent = '';
        $('#progressWarnings').innerHTML = '';
        $('#progressWarnings').classList.add('hidden');
        updateQueueBadge();

        // Les statistiques torrent n'ont de sens que pour un torrent
        $('#torrentStats').classList.toggle('hidden', currentKind !== 'torrent');

        const params = new URLSearchParams(item.params);
        eventSource = new EventSource(`/api/download?${params}`);
        // `finished` évite que l'événement natif 'error' de EventSource — émis
        // systématiquement à la fermeture du flux — n'écrase le vrai résultat.
        let finished = false;

        const closeStream = () => {
            if (eventSource) { eventSource.close(); eventSource = null; }
        };

        const nextOrFinish = () => {
            queueIndex++;
            if (!queueAborted && queueIndex < queue.length) {
                setTimeout(runQueueItem, 400);
            } else {
                showSection('complete');
                const done = queue.length;
                $('#completeFilename').textContent = done > 1
                    ? `${done} fichiers téléchargés`
                    : (lastCompletedName || 'Vidéo téléchargée');
                showToast('Téléchargement terminé ! 🎉', 'success');
                loadHistory();
            }
        };

        eventSource.addEventListener('start', (e) => {
            const data = JSON.parse(e.data);
            currentDownloadId = data.downloadId;
            $('#progressStatus').textContent = data.message;
        });

        eventSource.addEventListener('info', (e) => {
            const data = JSON.parse(e.data);
            if (data.filename) {
                $('#progressFilename').textContent = truncate(data.filename, 60);
            }
        });

        eventSource.addEventListener('progress', (e) => {
            const data = JSON.parse(e.data);
            const percent = parseFloat(data.percent) || 0;
            $('#progressPercent').textContent = data.percent;
            $('#progressBar').style.width = `${Math.min(percent, 100)}%`;
            $('#progressSpeed').textContent = data.speed || '—';
            $('#progressEta').textContent = data.eta || '—';
            $('#progressSize').textContent = data.size || '—';

            if (data.torrent) {
                const t = data.torrent;
                $('#torrentStats').classList.remove('hidden');
                $('#statPeers').textContent = t.peers;
                $('#statSeeders').textContent = t.seeders;
                $('#statUpload').textContent = t.uploadSpeed;
                $('#statRatio').textContent = t.ratio;
            }
        });

        eventSource.addEventListener('status', (e) => {
            $('#progressStatus').textContent = JSON.parse(e.data).message;
        });

        eventSource.addEventListener('warning', (e) => {
            const data = JSON.parse(e.data);
            const container = $('#progressWarnings');
            container.classList.remove('hidden');
            const items = container.querySelectorAll('.warning-item');
            if (items.length >= 3) items[0].remove();
            const w = document.createElement('div');
            w.className = 'warning-item';
            w.textContent = '⚠️ ' + data.message;
            container.appendChild(w);
        });

        eventSource.addEventListener('complete', (e) => {
            finished = true;
            const data = JSON.parse(e.data);
            lastCompletedName = data.filename || '';
            closeStream();
            currentDownloadId = null;
            nextOrFinish();
        });

        eventSource.addEventListener('cancelled', () => {
            finished = true;
            closeStream();
            currentDownloadId = null;
        });

        // Erreur applicative envoyée par le serveur (event: error + data JSON)
        eventSource.addEventListener('error', (e) => {
            if (finished || queueAborted) return;
            if (!e.data) {
                // Événement natif : le flux a été coupé sans message applicatif.
                if (eventSource && eventSource.readyState === EventSource.CLOSED) {
                    finished = true;
                    closeStream();
                    showError('Connexion au serveur interrompue pendant le téléchargement.');
                }
                return;
            }
            finished = true;
            let message = 'Échec du téléchargement';
            try { message = JSON.parse(e.data).message || message; } catch { }
            closeStream();
            currentDownloadId = null;

            // Dans un lot, on signale et on passe à l'épisode suivant.
            if (queue.length > 1 && queueIndex < queue.length - 1) {
                showToast(`${queue[queueIndex].label} : ${message}`, 'error');
                nextOrFinish();
            } else {
                showError(message);
            }
        });
    }

    // ─── Open Folder ────────────────────────────
    function openFolder() {
        fetch('/api/open-folder');
    }

    // ─── Load Download History ──────────────────
    async function loadHistory() {
        try {
            const res = await fetch('/api/downloads');
            const files = await res.json();

            const list = $('#historyList');

            if (!files.length) {
                list.innerHTML = `
                    <div class="history-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        <p>Aucun téléchargement pour l'instant</p>
                    </div>
                `;
                return;
            }

            list.innerHTML = '';
            for (const [i, file] of files.slice(0, 30).entries()) {
                list.appendChild(buildHistoryItem(file, i));
            }
        } catch { }
    }

    // Jeux d'icônes par famille de fichiers (tracés simples, 24×24).
    const svg = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const HISTORY_ICONS = {
        video: svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>'),
        audio: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
        image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
        document: svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
        archive: svg('<path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/>'),
        disque: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>'),
        logiciel: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
        soustitre: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="14" x2="11" y2="14"/><line x1="14" y1="14" x2="18" y2="14"/>'),
        donnees: svg('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
        dossier: svg('<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'),
        autre: svg('<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>'),
    };

    // ─── Un élément d'historique, construit en DOM ──
    // L'ancienne version interpolait le nom du fichier dans un attribut
    // onclick="…('…')". Un titre de vidéo contenant une apostrophe cassait le
    // bouton, et un titre malveillant permettait d'exécuter du JS dans la page.
    // On construit donc les nœuds et on attache les gestionnaires directement.
    function buildHistoryItem(file, i) {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.style.animationDelay = `${i * 0.05}s`;

        // L'historique ne contient plus seulement des vidéos : l'icône suit
        // la nature du fichier (ou du dossier, pour un torrent multi-fichiers).
        const icon = document.createElement('div');
        icon.className = 'history-item-icon cat-' + (file.category || 'autre');
        icon.innerHTML = HISTORY_ICONS[file.category] || HISTORY_ICONS.autre;

        const info = document.createElement('div');
        info.className = 'history-item-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'history-item-name';
        nameEl.textContent = file.name;      // textContent : jamais interprété
        nameEl.title = file.name;
        const meta = document.createElement('div');
        meta.className = 'history-item-meta';
        const sizeEl = document.createElement('span');
        sizeEl.textContent = formatSize(file.size);
        const dateEl = document.createElement('span');
        dateEl.textContent = formatDate(file.date);
        meta.append(sizeEl, dateEl);
        info.append(nameEl, meta);

        const actions = document.createElement('div');
        actions.className = 'history-item-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'btn-item-action';
        openBtn.title = 'Ouvrir la vidéo';
        openBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>';
        openBtn.addEventListener('click', () => openFile(file.name));

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-item-action danger';
        delBtn.title = 'Supprimer le fichier';
        delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
        delBtn.addEventListener('click', () => deleteFile(file.name, delBtn));

        actions.append(openBtn, delBtn);
        item.append(icon, info, actions);
        return item;
    }

    // Le serveur n'accepte qu'un nom de fichier, résolu dans le dossier de
    // téléchargement : plus de chemin absolu manipulable depuis le client.
    async function openFile(name) {
        try {
            const res = await fetch(`/api/open-file?name=${encodeURIComponent(name)}`);
            if (!res.ok) showToast('Fichier introuvable — il a peut-être été déplacé.', 'warning');
        } catch { showToast('Serveur injoignable', 'error'); }
    }

    // Suppression en deux temps : un premier clic arme, le second confirme.
    async function deleteFile(name, btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.classList.add('armed');
            btn.title = 'Cliquez à nouveau pour confirmer la suppression';
            showToast('Cliquez à nouveau pour confirmer la suppression', 'warning');
            setTimeout(() => {
                btn.dataset.armed = '0';
                btn.classList.remove('armed');
                btn.title = 'Supprimer le fichier';
            }, 4000);
            return;
        }
        try {
            const res = await fetch('/api/delete-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                showToast('Fichier supprimé', 'success');
                loadHistory();
            } else {
                showToast('Suppression impossible : ' + (data.error || res.status), 'error');
            }
        } catch { showToast('Serveur injoignable', 'error'); }
    }

    // ─── Annulation ─────────────────────────────
    async function cancelDownload() {
        queueAborted = true;
        queue = [];
        if (eventSource) { eventSource.close(); eventSource = null; }
        if (currentDownloadId) {
            try {
                await fetch('/api/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ downloadId: currentDownloadId })
                });
            } catch { }
        }
        currentDownloadId = null;
        showToast('Téléchargement annulé', 'warning');
        showSection('video');
    }

    // ─── Section Visibility ─────────────────────
    function showSection(name) {
        loadingSection.classList.add('hidden');
        videoSection.classList.add('hidden');
        progressSection.classList.add('hidden');
        completeSection.classList.add('hidden');
        errorSection.classList.add('hidden');

        switch (name) {
            case 'loading': loadingSection.classList.remove('hidden'); break;
            case 'video': videoSection.classList.remove('hidden'); break;
            case 'progress': progressSection.classList.remove('hidden'); break;
            case 'complete': completeSection.classList.remove('hidden'); break;
            case 'error': errorSection.classList.remove('hidden'); break;
        }
    }

    function showError(message) {
        showSection('error');
        $('#errorMessage').textContent = message;
    }

    function resetToInput() {
        if (eventSource) { eventSource.close(); eventSource = null; }
        queue = [];
        queueIndex = 0;
        queueAborted = false;
        currentDownloadId = null;
        lastCompletedName = '';
        showSection(null);
        urlInput.value = '';
        urlInput.focus();
        currentVideoInfo = null;
        currentKind = 'video';
        torrentFiles = [];
        selectedFormat = 'best';
        const ts = $('#torrentStats');
        if (ts) ts.classList.add('hidden');
        btnDownload.disabled = false;
    }

    // ─── Toast Notifications ────────────────────
    function showToast(message, type = 'success') {
        const container = $('#toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('leaving');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ─── Helpers ────────────────────────────────
    function formatNumber(num) {
        if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
        return num.toString();
    }

    function formatSize(bytes) {
        const n = Number(bytes) || 0;
        if (n === 0) return '0 o';
        // Mêmes unités que le serveur (o/Ko/Mo/Go), sinon le même écran
        // affichait « 941.5 Ko » d'un côté et « 1.5 KB » de l'autre.
        const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
        let i = 0;
        let size = n;
        while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
        return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const now = new Date();
        const diff = now - d;
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (mins < 1) return 'à l\'instant';
        if (mins < 60) return `il y a ${mins} min`;
        if (hours < 24) return `il y a ${hours} h`;
        if (days < 7) return `il y a ${days} j`;
        return d.toLocaleDateString();
    }

    function truncate(str, max) {
        if (str.length <= max) return str;
        return str.substring(0, max - 3) + '...';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Start ──────────────────────────────────
    // `defer` garantit l'exécution avant DOMContentLoaded, mais on garde un
    // filet si le script est un jour chargé après coup.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
