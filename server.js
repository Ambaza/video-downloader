const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const app = express();
const PORT = 3000;

// Downloads directory
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'VideoDownloader');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Track active downloads
const activeDownloads = new Map();

// Settings (persisted)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
let settings = {
    useCookieFile: false,   // Whether to use cookies.txt
};
try {
    if (fs.existsSync(SETTINGS_FILE)) {
        settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
} catch { }

function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Find yt-dlp binary ──────────────────────────────────────────
let _ytdlpPath = null;

function getYtDlpPath() {
    if (_ytdlpPath) return _ytdlpPath;

    const localPath = path.join(__dirname, 'bin', 'yt-dlp.exe');
    if (fs.existsSync(localPath)) { _ytdlpPath = localPath; return _ytdlpPath; }

    const home = os.homedir();
    const pythonVersions = ['Python313', 'Python312', 'Python311', 'Python310', 'Python39'];
    for (const ver of pythonVersions) {
        const p = path.join(home, 'AppData', 'Roaming', 'Python', ver, 'Scripts', 'yt-dlp.exe');
        if (fs.existsSync(p)) { _ytdlpPath = p; return _ytdlpPath; }
        const p2 = path.join(home, 'AppData', 'Local', 'Programs', 'Python', ver, 'Scripts', 'yt-dlp.exe');
        if (fs.existsSync(p2)) { _ytdlpPath = p2; return _ytdlpPath; }
    }

    _ytdlpPath = 'yt-dlp';
    return _ytdlpPath;
}

// ─── Check if cookies.txt exists ─────────────────────────────────
function hasCookieFile() {
    return fs.existsSync(COOKIES_FILE);
}

// ─── Build common yt-dlp args for robustness ─────────────────────
function buildRobustArgs(url, extraArgs = []) {
    const args = [
        '--no-playlist',
        '--no-warnings',
        // Network resilience
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', 'fragment:exp=1:2:30',
        // Avoid throttling
        '--throttled-rate', '100K',
        // Ignore SSL issues for some sites
        '--no-check-certificates',
        // Add user agent to avoid blocks
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        // Add referer from URL
        '--referer', url,
        ...extraArgs,
    ];

    // Add cookies file if available and enabled
    if (settings.useCookieFile && hasCookieFile()) {
        args.push('--cookies', COOKIES_FILE);
    }

    args.push(url);
    return args;
}

// ─── Anime-Sama Parser ───────────────────────────────────────────
async function parseAnimeSama(url) {
    try {
        // Ensure url ends with / to fetch episodes.js correctly
        let baseUrl = url.split('?')[0];
        if (!baseUrl.endsWith('/')) baseUrl += '/';
        
        const episodesJsUrl = baseUrl + 'episodes.js';
        const response = await fetch(episodesJsUrl);
        if (!response.ok) return null;
        
        const content = await response.text();
        
        // Extract arrays: var eps1 = [...];
        const players = {};
        const regex = /var\s+(eps\d+)\s*=\s*\[([\s\S]*?)\];/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const varName = match[1];
            const linksText = match[2];
            // Split by comma, handling potential comments and line breaks
            const links = linksText
                .split('\n')
                .map(line => {
                    const l = line.trim();
                    if (!l || l.startsWith('//')) return null;
                    const linkMatch = l.match(/['"](https?:\/\/[^'"]+)['"]/);
                    return linkMatch ? linkMatch[1] : null;
                })
                .filter(Boolean);
            
            if (links.length > 0) {
                players[varName] = links;
            }
        }

        if (Object.keys(players).length === 0) return null;

        // Map player keys to readable names if possible, or just Player 1, 2...
        const playerMap = {
            eps1: 'Player 1 (Sibnet/Primary)',
            eps2: 'Player 2 (Vidmoly)',
            eps3: 'Player 3 (Sendvid)',
            eps4: 'Player 4',
            eps5: 'Player 5'
        };

        const formattedPlayers = Object.keys(players).map(key => ({
            id: key,
            name: playerMap[key] || key.toUpperCase(),
            count: players[key].length,
            links: players[key]
        }));

        // Sort by episode count descending to find the main list
        formattedPlayers.sort((a, b) => b.count - a.count);

        return {
            isAnimeSama: true,
            title: baseUrl.split('/').filter(Boolean).pop().replace(/-/g, ' ').toUpperCase(),
            baseUrl,
            players: formattedPlayers,
            maxEpisodes: Math.max(...formattedPlayers.map(p => p.count))
        };
    } catch (e) {
        console.error('Anime-Sama Parse Error:', e);
        return null;
    }
}

// ─── GET /api/info — Fetch video metadata ─────────────────────────
app.get('/api/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Handle Anime-Sama URLs
    if (url.includes('anime-sama.to/catalogue/')) {
        const asData = await parseAnimeSama(url);
        if (asData) {
            return res.json({
                title: asData.title,
                thumbnail: 'https://anime-sama.to/template/images/logo.png',
                isAnimeSama: true,
                asData: asData,
                presets: []
            });
        }
    }

    const ytdlp = getYtDlpPath();
    const args = buildRobustArgs(url, ['--dump-json']);

    let output = '';
    let errorOutput = '';

    const proc = spawn(ytdlp, args, { windowsHide: true });

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errorOutput += data.toString(); });

    proc.on('close', (code) => {
        if (code !== 0) {
            console.error('yt-dlp info error:', errorOutput);

            let userMessage = 'Failed to fetch video info.';
            const detailLower = errorOutput.toLowerCase();

            if (detailLower.includes('not found') || detailLower.includes('404') || detailLower.includes('unavailable')) {
                userMessage = 'Video not found. It may have been removed or the URL is incorrect.';
            } else if (detailLower.includes('private') || detailLower.includes('login') || detailLower.includes('sign in')) {
                userMessage = 'This video requires login. Export cookies from your browser (see Settings for instructions).';
            } else if (detailLower.includes('geo') || detailLower.includes('country') || detailLower.includes('region')) {
                userMessage = 'This video is geo-restricted and not available in your region. Try using a VPN.';
            } else if (detailLower.includes('unsupported url') || detailLower.includes('no suitable')) {
                userMessage = 'This URL/site is not supported by yt-dlp.';
            } else if (detailLower.includes('age') || detailLower.includes('mature') || detailLower.includes('18')) {
                userMessage = 'Age-restricted content. Export your browser cookies via extension (see Settings).';
            } else if (detailLower.includes('decrypt') || detailLower.includes('dpapi')) {
                userMessage = 'Could not read browser cookies (Chrome DPAPI encryption). Use a cookies.txt file instead — see Settings for instructions.';
            }

            return res.status(500).json({
                error: userMessage,
                details: errorOutput.substring(0, 500) || 'Unknown error.'
            });
        }

        try {
            const firstJson = output.split('\n').find(l => l.trim().startsWith('{'));
            const info = JSON.parse(firstJson || output);

            const formats = (info.formats || [])
                .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
                .map(f => ({
                    format_id: f.format_id,
                    ext: f.ext,
                    resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : 'audio only'),
                    filesize: f.filesize || f.filesize_approx || null,
                    fps: f.fps || null,
                    vcodec: f.vcodec,
                    acodec: f.acodec,
                    tbr: f.tbr || null,
                    format_note: f.format_note || '',
                    hasVideo: f.vcodec !== 'none',
                    hasAudio: f.acodec !== 'none',
                }));

            const presets = [
                { id: 'best', label: 'Best Quality (Video + Audio)', description: 'Highest available quality' },
                { id: 'bestvideo+bestaudio/best', label: 'Best Video + Best Audio (merged)', description: 'May require ffmpeg' },
                { id: 'worst', label: 'Lowest Quality', description: 'Smallest file size' },
            ];

            const resolutions = [2160, 1440, 1080, 720, 480, 360];
            for (const r of resolutions) {
                const hasRes = (info.formats || []).some(f => f.height === r);
                if (hasRes) {
                    presets.push({
                        id: `bestvideo[height<=${r}]+bestaudio/best[height<=${r}]`,
                        label: `${r}p`,
                        description: `Up to ${r}p quality`
                    });
                }
            }

            presets.push({
                id: 'bestaudio/best',
                label: 'Audio Only (Best)',
                description: 'Extract audio only'
            });

            res.json({
                title: info.title,
                thumbnail: info.thumbnail,
                duration: info.duration,
                duration_string: info.duration_string,
                uploader: info.uploader || info.channel || info.uploader_id,
                view_count: info.view_count,
                upload_date: info.upload_date,
                description: (info.description || '').substring(0, 300),
                webpage_url: info.webpage_url,
                extractor: info.extractor || info.extractor_key,
                formats,
                presets
            });
        } catch (e) {
            console.error('Parse error:', e.message);
            res.status(500).json({ error: 'Failed to parse video info.' });
        }
    });

    proc.on('error', (err) => {
        console.error('Spawn error:', err);
        res.status(500).json({
            error: 'yt-dlp not found. Please install it first.',
            details: err.message
        });
    });
});

// ─── GET /api/download — Download with SSE progress ───────────────
app.get('/api/download', (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const downloadId = uuidv4();

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendEvent = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { }
    };

    const ytdlp = getYtDlpPath();
    const outputTemplate = path.join(DOWNLOADS_DIR, '%(title).150s.%(ext)s');

    const downloadArgs = buildRobustArgs(url, [
        '-f', format || 'best',
        '-o', outputTemplate,
        '--newline',
        '--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s',
        '--trim-filenames', '150',
    ]);

    sendEvent('start', { downloadId, message: 'Download starting...' });

    const proc = spawn(ytdlp, downloadArgs, { windowsHide: true });
    activeDownloads.set(downloadId, proc);

    let lastFilename = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
            const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
            if (destMatch) {
                lastFilename = path.basename(destMatch[1].trim());
                sendEvent('info', { filename: lastFilename });
                continue;
            }

            const alreadyMatch = line.match(/\[download\]\s+(.+)\s+has already been downloaded/);
            if (alreadyMatch) {
                lastFilename = path.basename(alreadyMatch[1].trim());
                sendEvent('info', { filename: lastFilename });
                sendEvent('progress', { percent: '100%', speed: '-', eta: '0s', size: '-' });
                continue;
            }

            if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[Metadata]')) {
                sendEvent('status', { message: 'Processing...' });
                continue;
            }

            if (line.includes('[FixupM3u8]') || line.includes('[ffmpeg]')) {
                sendEvent('status', { message: 'Converting video format...' });
                continue;
            }

            const fragMatch = line.match(/\[download\]\s+Downloading\s+(\d+)\s+fragments?/i);
            if (fragMatch) {
                sendEvent('status', { message: `Downloading ${fragMatch[1]} fragments...` });
                continue;
            }

            if (line.includes('Retrying') || line.includes('Got error')) {
                sendEvent('status', { message: 'Retrying...' });
                continue;
            }

            const parts = line.trim().split('|');
            if (parts.length === 4) {
                sendEvent('progress', {
                    percent: parts[0].trim(),
                    speed: parts[1].trim(),
                    eta: parts[2].trim(),
                    size: parts[3].trim()
                });
            }
        }
    });

    proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        stderrBuffer += msg + '\n';
        if (msg && (msg.includes('WARNING') || msg.includes('ERROR'))) {
            sendEvent('warning', { message: msg.substring(0, 200) });
        }
    });

    proc.on('close', (code) => {
        activeDownloads.delete(downloadId);
        if (code === 0) {
            if (!lastFilename) {
                try {
                    const files = fs.readdirSync(DOWNLOADS_DIR)
                        .filter(n => !n.endsWith('.part') && !n.endsWith('.ytdl'))
                        .map(name => ({ name, time: fs.statSync(path.join(DOWNLOADS_DIR, name)).mtimeMs }))
                        .sort((a, b) => b.time - a.time);
                    if (files.length > 0) lastFilename = files[0].name;
                } catch { }
            }
            sendEvent('complete', {
                message: 'Download complete!',
                filename: lastFilename,
                directory: DOWNLOADS_DIR
            });
        } else {
            let errorMsg = `Download failed (exit code ${code}).`;
            const stderrLower = stderrBuffer.toLowerCase();

            if (stderrLower.includes('http error 403') || stderrLower.includes('forbidden')) {
                errorMsg = 'Access denied (403). Try importing browser cookies via Settings.';
            } else if (stderrLower.includes('http error 429') || stderrLower.includes('too many')) {
                errorMsg = 'Rate-limited. Wait a few minutes and try again.';
            } else if (stderrLower.includes('decrypt') || stderrLower.includes('dpapi')) {
                errorMsg = 'Could not read browser cookies. Use a cookies.txt file instead — see Settings.';
            } else if (stderrLower.includes('fragment') && stderrLower.includes('error')) {
                errorMsg = 'Fragment download errors. Try a different quality or refresh the video URL.';
            } else if (stderrLower.includes('unable to download') || stderrLower.includes('giving up')) {
                errorMsg = 'Could not download after several retries. Try different quality or check the URL.';
            } else if (stderrBuffer.trim()) {
                const errLines = stderrBuffer.trim().split('\n').filter(l => l.includes('ERROR') || l.includes('error'));
                if (errLines.length > 0) {
                    errorMsg = errLines[errLines.length - 1].substring(0, 300);
                }
            }
            sendEvent('error', { message: errorMsg });
        }
        res.end();
    });

    proc.on('error', (err) => {
        activeDownloads.delete(downloadId);
        sendEvent('error', { message: `Failed to start download: ${err.message}` });
        res.end();
    });

    req.on('close', () => {
        if (activeDownloads.has(downloadId)) {
            proc.kill('SIGTERM');
            activeDownloads.delete(downloadId);
        }
    });
});

// ─── POST /api/cancel ────────────────────────────────────────────
app.post('/api/cancel', (req, res) => {
    const { downloadId } = req.body;
    if (activeDownloads.has(downloadId)) {
        activeDownloads.get(downloadId).kill('SIGTERM');
        activeDownloads.delete(downloadId);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Download not found' });
    }
});

// ─── GET /api/downloads ──────────────────────────────────────────
app.get('/api/downloads', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl'))
            .map(name => {
                const filePath = path.join(DOWNLOADS_DIR, name);
                const stats = fs.statSync(filePath);
                return { name, size: stats.size, date: stats.mtime, path: filePath };
            }).sort((a, b) => b.date - a.date);
        res.json(files);
    } catch {
        res.json([]);
    }
});

// ─── GET /api/open-file ──────────────────────────────────────────
app.get('/api/open-file', (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    const { exec } = require('child_process');
    // On Windows, 'start' opens the file with default app
    exec(`start "" "${filePath}"`);
    res.json({ success: true });
});

// ─── GET/POST /api/settings ──────────────────────────────────────
app.get('/api/settings', (req, res) => {
    res.json({
        ...settings,
        hasCookieFile: hasCookieFile(),
        cookieFilePath: COOKIES_FILE,
        downloadsDir: DOWNLOADS_DIR,
    });
});

app.post('/api/settings', (req, res) => {
    const { useCookieFile } = req.body;
    if (useCookieFile !== undefined) {
        settings.useCookieFile = useCookieFile;
    }
    saveSettings();
    res.json({ success: true, settings });
});

// ─── POST /api/upload-cookies — Upload cookies.txt file ──────────
const multerFree = (req, callback) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => callback(body));
};

app.post('/api/upload-cookies', (req, res) => {
    // Read raw body as text
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        if (!body.trim()) {
            return res.status(400).json({ error: 'Empty cookie file' });
        }
        try {
            fs.writeFileSync(COOKIES_FILE, body, 'utf8');
            settings.useCookieFile = true;
            saveSettings();
            res.json({ success: true, message: 'Cookies saved!' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save cookies: ' + e.message });
        }
    });
});

// ─── Check yt-dlp availability ───────────────────────────────────
app.get('/api/check', (req, res) => {
    const ytdlp = getYtDlpPath();
    const proc = spawn(ytdlp, ['--version'], { windowsHide: true });

    let version = '';
    proc.stdout.on('data', (d) => { version += d.toString(); });

    proc.on('close', (code) => {
        if (code === 0) {
            res.json({
                installed: true,
                version: version.trim(),
                downloadsDir: DOWNLOADS_DIR,
                hasCookieFile: hasCookieFile(),
            });
        } else {
            res.json({ installed: false });
        }
    });

    proc.on('error', () => {
        res.json({ installed: false });
    });
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  🎬 Video Downloader running at http://localhost:${PORT}`);
    console.log(`  📁 Downloads saved to: ${DOWNLOADS_DIR}`);
    console.log(`  🍪 Cookie file: ${hasCookieFile() ? 'Found ✓' : 'Not found (optional)'}`);
    console.log(`  📍 yt-dlp: ${getYtDlpPath()}\n`);
});
