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
    let selectedFormat = 'best';
    let currentDownloadId = null;
    let eventSource = null;

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

                const cookieInfo = $('#cookieInfo');
                if (data.hasCookieFile) {
                    cookieInfo.textContent = '🍪 cookies.txt ✓';
                    cookieInfo.style.display = '';
                } else {
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
                if (urlInput.value.trim() && isValidUrl(urlInput.value.trim())) {
                    fetchVideoInfo();
                }
            }, 100);
        });

        // Cookie file upload
        const cookieFileInput = $('#cookieFileInput');
        const btnUploadCookie = $('#btnUploadCookie');
        if (btnUploadCookie && cookieFileInput) {
            btnUploadCookie.addEventListener('click', () => cookieFileInput.click());
            cookieFileInput.addEventListener('change', uploadCookieFile);
        }

        // Toggle cookie usage
        const useCookieToggle = $('#useCookieToggle');
        if (useCookieToggle) {
            useCookieToggle.addEventListener('change', async () => {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ useCookieFile: useCookieToggle.checked })
                });
                showToast(useCookieToggle.checked ? 'Cookies enabled' : 'Cookies disabled', 'success');
                checkYtDlp();
            });
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
                showToast('Cookies imported successfully! 🍪', 'success');
                // Update UI
                const useCookieToggle = $('#useCookieToggle');
                if (useCookieToggle) useCookieToggle.checked = true;
                const cookieStatus = $('#cookieStatus');
                if (cookieStatus) {
                    cookieStatus.textContent = '✅ cookies.txt loaded';
                    cookieStatus.className = 'cookie-status active';
                }
                checkYtDlp();
            } else {
                showToast('Failed to import cookies: ' + (data.error || 'Unknown error'), 'error');
            }
        } catch {
            showToast('Failed to upload cookie file', 'error');
        }

        // Reset file input
        e.target.value = '';
    }

    // ─── Open Settings ──────────────────────────
    async function openSettings() {
        if (!settingsModal) return;
        settingsModal.classList.remove('hidden');

        try {
            const res = await fetch('/api/settings');
            const data = await res.json();

            const useCookieToggle = $('#useCookieToggle');
            if (useCookieToggle) {
                useCookieToggle.checked = !!data.useCookieFile;
            }

            const cookieStatus = $('#cookieStatus');
            if (cookieStatus) {
                if (data.hasCookieFile) {
                    cookieStatus.textContent = '✅ cookies.txt loaded';
                    cookieStatus.className = 'cookie-status active';
                } else {
                    cookieStatus.textContent = '⚠️ No cookie file — upload one to access restricted content';
                    cookieStatus.className = 'cookie-status inactive';
                }
            }

            const dirEl = $('#downloadsDir');
            if (dirEl) dirEl.textContent = data.downloadsDir || 'Unknown';

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
    function isValidUrl(str) {
        try {
            const u = new URL(str);
            return ['http:', 'https:'].includes(u.protocol);
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
            showToast('Please enter a valid URL', 'warning');
            urlInput.focus();
            return;
        }

        showSection('loading');

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
        const thumb = $('#videoThumbnail');
        if (info.thumbnail) {
            thumb.src = info.thumbnail;
            thumb.alt = info.title;
            thumb.style.display = '';
            thumb.onerror = () => { thumb.style.display = 'none'; };
        } else {
            thumb.style.display = 'none';
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

    // ─── Anime-Sama Controls ────────────────────
    function renderAnimeSamaControls(data) {
        const pSelect = $('#asPlayerSelect');
        const eSelect = $('#asEpisodeSelect');

        pSelect.innerHTML = data.players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        
        const updateEpisodes = () => {
            const player = data.players.find(p => p.id === pSelect.value);
            eSelect.innerHTML = player.links.map((_, i) => `<option value="${i}">Episode ${i + 1}</option>`).join('');
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
    function startDownload() {
        const url = (currentVideoInfo && currentVideoInfo.isAnimeSama) 
            ? currentVideoInfo.activeEpisodeUrl 
            : urlInput.value.trim();
            
        if (!url) return;

        showSection('progress');

        $('#progressFilename').textContent = 'Downloading...';
        $('#progressPercent').textContent = '0%';
        $('#progressBar').style.width = '0%';
        $('#progressSpeed').textContent = '—';
        $('#progressEta').textContent = '—';
        $('#progressSize').textContent = '—';
        $('#progressStatus').textContent = '';
        $('#progressWarnings').innerHTML = '';
        $('#progressWarnings').classList.add('hidden');

        const params = new URLSearchParams({ url, format: selectedFormat });
        eventSource = new EventSource(`/api/download?${params}`);

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
        });

        eventSource.addEventListener('status', (e) => {
            const data = JSON.parse(e.data);
            $('#progressStatus').textContent = data.message;
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
            const data = JSON.parse(e.data);
            eventSource.close();
            eventSource = null;

            showSection('complete');
            $('#completeFilename').textContent = data.filename || 'Video downloaded';
            showToast('Download complete! 🎉', 'success');
            loadHistory();
        });

        eventSource.addEventListener('error', (e) => {
            if (eventSource && eventSource.readyState === EventSource.CLOSED) {
                return;
            }

            let message = 'Download failed';
            try {
                const data = JSON.parse(e.data);
                message = data.message || message;
            } catch { }

            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }

            showError(message);
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
                        <p>No downloads yet</p>
                    </div>
                `;
                return;
            }

            list.innerHTML = files.slice(0, 20).map((file, i) => `
                <div class="history-item" style="animation-delay: ${i * 0.05}s">
                    <div class="history-item-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="23 7 16 12 23 17 23 7"/>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                        </svg>
                    </div>
                    <div class="history-item-info">
                        <div class="history-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                        <div class="history-item-meta">
                            <span>${formatSize(file.size)}</span>
                            <span>${formatDate(file.date)}</span>
                        </div>
                    </div>
                    <div class="history-item-actions">
                        <button class="btn-item-action" onclick="window.openFile('${escapeHtml(file.path.replace(/\\/g, '/'))}')" title="Open Video">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `).join('');
            
            // Add openFile to window for the onclick above
            window.openFile = (path) => {
                fetch(`/api/open-file?path=${encodeURIComponent(path)}`);
            };
        } catch { }
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
        showSection(null);
        urlInput.value = '';
        urlInput.focus();
        currentVideoInfo = null;
        selectedFormat = 'best';
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
        if (!bytes) return '—';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let size = bytes;
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

        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
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
    document.addEventListener('DOMContentLoaded', init);
})();
