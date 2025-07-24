const http = require('http');
const request = require('request');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class StreamManager extends EventEmitter {
    constructor() {
        super();
        this.activeStreams = new Map(); // cameraKey -> Set of client responses
        this.cameraConnections = new Map(); // cameraKey -> connection info
        this.connectionTimeouts = new Map(); // cameraKey -> timeout handle
        this.maxIdleTime = 30000; // 30 seconds
    }

    proxyStream(req, res, cameraKey, cameraConfig) {
        const selectedCamera = cameraConfig[cameraKey];
        if (!selectedCamera) {
            this.safeResponse(res, 404, 'Camera not found');
            return;
        }

        console.log(`[STREAM] Client requesting stream for camera: ${cameraKey}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        this.addClient(cameraKey, res);

        const cleanup = () => {
            console.log(`[STREAM] Client disconnected from camera: ${cameraKey}`);
            this.removeClient(cameraKey, res);
        };

        req.on('close', cleanup);
        req.on('error', (error) => {
            console.log(`[STREAM] Client request error for camera ${cameraKey}:`, error.message);
            cleanup();
        });
        res.on('error', (error) => {
            console.log(`[STREAM] Client response error for camera ${cameraKey}:`, error.message);
            cleanup();
        });

        const connectionTimeout = setTimeout(() => {
            console.error(`[STREAM] Connection timeout for camera: ${cameraKey}`);
            this.safeResponse(res, 504, 'Camera connection timeout');
            cleanup();
        }, 15000);

        this.getCameraStream(cameraKey, selectedCamera, (err, cameraStream) => {
            clearTimeout(connectionTimeout);
            if (err) {
                console.error(`[STREAM] Error getting camera stream: ${err.message}`);
                this.safeResponse(res, 502, `Camera error: ${err.message}`);
                cleanup();
                return;
            }
            if (res.destroyed || res.headersSent) {
                console.log(`[STREAM] Response already closed for camera: ${cameraKey}`);
                cleanup();
                return;
            }
            try {
                res.setHeader('Content-Type', cameraStream.headers['content-type'] || 'video/x-flv');
                res.writeHead(200);
                cameraStream.pipe(res, { end: false });
                cameraStream.on('error', (error) => {
                    console.error(`[STREAM] Upstream stream error for camera ${cameraKey}:`, error.message);
                    cleanup();
                });
                cameraStream.on('end', () => {
                    console.log(`[STREAM] Upstream stream ended for camera: ${cameraKey}`);
                    cleanup();
                });
            } catch (error) {
                console.error(`[STREAM] Error setting up stream pipe: ${error.message}`);
                this.safeResponse(res, 500, 'Stream setup error');
                cleanup();
            }
        });
    }

    safeResponse(res, statusCode, message) {
        try {
            if (!res.destroyed && !res.headersSent) {
                res.writeHead(statusCode).end(message);
            }
        } catch (error) {
            console.warn(`[STREAM] Error sending response: ${error.message}`);
        }
    }

    addClient(cameraKey, clientRes) {
        if (!this.activeStreams.has(cameraKey)) {
            this.activeStreams.set(cameraKey, new Set());
        }
        this.activeStreams.get(cameraKey).add(clientRes);
        if (this.connectionTimeouts.has(cameraKey)) {
            clearTimeout(this.connectionTimeouts.get(cameraKey));
            this.connectionTimeouts.delete(cameraKey);
        }
        console.log(`[STREAM] Active clients for ${cameraKey}: ${this.activeStreams.get(cameraKey).size}`);
    }

    removeClient(cameraKey, clientRes) {
        if (this.activeStreams.has(cameraKey)) {
            this.activeStreams.get(cameraKey).delete(clientRes);
            const remainingClients = this.activeStreams.get(cameraKey).size;
            console.log(`[STREAM] Remaining clients for ${cameraKey}: ${remainingClients}`);
            if (remainingClients === 0) {
                this.scheduleCleanup(cameraKey);
            }
        }
    }

    getCameraStream(cameraKey, cameraConfig, callback) {
        if (this.cameraConnections.has(cameraKey)) {
            const connectionInfo = this.cameraConnections.get(cameraKey);
            if (connectionInfo.stream && !connectionInfo.stream.destroyed) {
                console.log(`[STREAM] Reusing existing connection for camera: ${cameraKey}`);
                return callback(null, connectionInfo.stream);
            } else {
                console.log(`[STREAM] Cleaning up dead connection for camera: ${cameraKey}`);
                this.cameraConnections.delete(cameraKey);
            }
        }

        const cameraUrl = `http://${cameraConfig.ip}:${cameraConfig.port}${cameraConfig.path}`;
        console.log(`[STREAM] Creating new connection to camera: ${cameraUrl}`);
        const streamReq = request.get({
            url: cameraUrl,
            timeout: 10000,
            headers: { 'User-Agent': 'StreamProxy/1.0', 'Connection': 'keep-alive', 'Accept': '*/*' },
            forever: false,
            pool: false
        });

        streamReq.on('response', (response) => {
            try {
                if (response.statusCode !== 200) {
                    return callback(new Error(`Camera returned status ${response.statusCode}`));
                }
                console.log(`[STREAM] Connected to camera ${cameraKey}, content-type: ${response.headers['content-type']}`);
                this.cameraConnections.set(cameraKey, {
                    stream: response,
                    request: streamReq,
                    createdAt: Date.now()
                });
                response.on('error', (err) => {
                    console.error(`[STREAM] Upstream error for camera ${cameraKey}: ${err.message}`);
                    this.cleanupCameraConnection(cameraKey);
                });
                response.on('end', () => {
                    console.log(`[STREAM] Upstream ended for camera ${cameraKey}`);
                    this.cleanupCameraConnection(cameraKey);
                });
                response.on('close', () => {
                    console.log(`[STREAM] Upstream closed for camera ${cameraKey}`);
                    this.cleanupCameraConnection(cameraKey);
                });
                callback(null, response);
            } catch (error) {
                console.error(`[STREAM] Error handling camera response: ${error.message}`);
                callback(error);
            }
        });
        streamReq.on('error', (err) => {
            console.error(`[STREAM] Request error for camera ${cameraKey}: ${err.message}`);
            callback(err);
        });
        streamReq.on('timeout', () => {
            console.error(`[STREAM] Request timeout for camera ${cameraKey}`);
            streamReq.abort();
            callback(new Error('Connection timeout'));
        });
    }

    scheduleCleanup(cameraKey) {
        if (this.connectionTimeouts.has(cameraKey)) {
            clearTimeout(this.connectionTimeouts.get(cameraKey));
        }
        console.log(`[STREAM] Scheduling cleanup for camera ${cameraKey} in ${this.maxIdleTime}ms`);
        const timeoutId = setTimeout(() => {
            if (!this.activeStreams.has(cameraKey) || this.activeStreams.get(cameraKey).size === 0) {
                console.log(`[STREAM] Cleaning up unused camera connection: ${cameraKey}`);
                this.cleanupCameraConnection(cameraKey);
            }
        }, this.maxIdleTime);
        this.connectionTimeouts.set(cameraKey, timeoutId);
    }

    cleanupCameraConnection(cameraKey) {
        console.log(`[STREAM] Cleaning up camera connection: ${cameraKey}`);
        if (this.connectionTimeouts.has(cameraKey)) {
            clearTimeout(this.connectionTimeouts.get(cameraKey));
        }
        this.connectionTimeouts.delete(cameraKey);
        
        if (this.cameraConnections.has(cameraKey)) {
            const connectionInfo = this.cameraConnections.get(cameraKey);
            try {
                if (connectionInfo.request && !connectionInfo.request.destroyed) connectionInfo.request.abort();
                if (connectionInfo.stream && !connectionInfo.stream.destroyed) connectionInfo.stream.destroy();
            } catch (error) {
                console.error(`[STREAM] Error cleaning up connection: ${error.message}`);
            }
            this.cameraConnections.delete(cameraKey);
        }
        if (this.activeStreams.has(cameraKey)) {
            this.activeStreams.delete(cameraKey);
        }
    }

    cleanup() {
        console.log('[STREAM] Cleaning up all stream connections...');
        for (const timeoutId of this.connectionTimeouts.values()) clearTimeout(timeoutId);
        this.connectionTimeouts.clear();
        for (const cameraKey of this.cameraConnections.keys()) this.cleanupCameraConnection(cameraKey);
        console.log('[STREAM] All stream connections cleaned up');
    }

    getStatus() {
        const status = {
            activeCameras: this.cameraConnections.size,
            totalClients: 0,
            cameras: {}
        };
        for (const [cameraKey, clients] of this.activeStreams.entries()) {
            status.totalClients += clients.size;
            status.cameras[cameraKey] = {
                clients: clients.size,
                connected: this.cameraConnections.has(cameraKey),
                hasTimeout: this.connectionTimeouts.has(cameraKey)
            };
        }
        return status;
    }
}

// --- Configuration ---
const CONFIG_PATH = './config.json';
const FINGERPRINTS_DB_PATH = './fingerprints.json';
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const PORT = 3000;

let cameraConfig, fingerprintsDb = {}, recordingProcess = null, currentRecordingCamera = null, recordingStartTime = null;
const recordingBuffer = 5;
let streamManager;

if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR);
    console.log(`Created recordings directory at: ${RECORDINGS_DIR}`);
}

try {
    cameraConfig = JSON.parse(fs.readFileSync(CONFIG_PATH)).cameras;
    console.log('Camera configuration loaded.');
    streamManager = new StreamManager();
} catch (error) {
    console.error(`FATAL: Could not read or parse ${CONFIG_PATH}. Exiting.`, error);
    process.exit(1);
}

try {
    if (fs.existsSync(FINGERPRINTS_DB_PATH)) {
        fingerprintsDb = JSON.parse(fs.readFileSync(FINGERPRINTS_DB_PATH));
        console.log('Audio fingerprints database loaded.');
    }
} catch (error) {
    console.error('Could not read or parse fingerprints.json.', error);
}

// --- Recording & Event Functions ---
function startBufferedRecording(cameraKey) {
    if (recordingProcess) return console.log('[RECORDING] Recording already in progress.');
    const camera = cameraConfig[cameraKey];
    if (!camera) return console.error(`[RECORDING] Error: Camera key "${cameraKey}" not found.`);
    
    const streamUrl = `http://${camera.ip}:${camera.port}${camera.path}`;
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
    const outputPath = path.join(RECORDINGS_DIR, `match-${timestamp}.mp4`);
    console.log(`[RECORDING] Starting recording for "${camera.name}" to ${outputPath}`);
    
    const ffmpegArgs = [
        '-y', '-i', streamUrl, '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts', '-timeout', '10000000', outputPath
    ];
    
    recordingProcess = spawn('ffmpeg', ffmpegArgs, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    currentRecordingCamera = cameraKey;
    recordingStartTime = Date.now();

    recordingProcess.stderr.on('data', (data) => {
        const out = data.toString();
        if (out.includes('error') || out.includes('frame=')) console.log(`[FFMPEG] ${out.substring(0, 200)}`);
    });
    recordingProcess.on('close', (code) => {
        console.log(`[FFMPEG] Process exited with code ${code}.`);
        [recordingProcess, currentRecordingCamera, recordingStartTime] = [null, null, null];
    });
    recordingProcess.on('error', (err) => {
        console.error('[FFMPEG] Failed to start ffmpeg process:', err);
        [recordingProcess, currentRecordingCamera, recordingStartTime] = [null, null, null];
    });
}

function stopBufferedRecording() {
    if (!recordingProcess) return;
    console.log('[RECORDING] Stopping buffered recording...');
    try {
        recordingProcess.stdin.write('q\n');
        setTimeout(() => { if (recordingProcess) recordingProcess.kill('SIGKILL'); }, 5000);
    } catch (err) {
        if (recordingProcess) recordingProcess.kill('SIGTERM');
    }
}

function handleMatchEvent(eventType, cameraKey) {
    switch (eventType) {
        case 'MATCH_START':
            console.log('[EVENT] Match start detected.');
            if (cameraKey) startBufferedRecording(cameraKey);
            else console.error('[EVENT] MATCH_START but no camera was provided.');
            break;
        case 'MATCH_END':
            console.log('[EVENT] Match end detected.');
            setTimeout(stopBufferedRecording, recordingBuffer * 1000);
            break;
        case 'MATCH_ABORT':
            console.log('[EVENT] Match aborted.');
            stopBufferedRecording();
            break;
    }
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const { pathname } = parsedUrl;
    const { method } = req;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') return res.writeHead(200).end();
    if (pathname.startsWith('/api/')) return handleApiRoutes(req, res, pathname, method, parsedUrl);
    
    if (method === 'GET') {
        const staticFiles = {
            '/': { path: 'index.html', type: 'text/html' },
            '/index.html': { path: 'index.html', type: 'text/html' },
            '/fingerprinter': { path: 'fingerprinter.html', type: 'text/html' },
            '/recordings': { path: 'recordings.html', type: 'text/html' }
        };
        if (staticFiles[pathname]) {
            return serveStaticFile(res, staticFiles[pathname].path, staticFiles[pathname].type);
        }
        if (pathname.match(/^\/recordings\/.+\.mp4$/)) {
            return serveStaticFile(res, pathname.substring(1), 'video/mp4');
        }
        if (pathname === '/stream') {
            return streamManager.proxyStream(req, res, parsedUrl.query.camera, cameraConfig);
        }
    }
    res.writeHead(404).end('Not Found');
});

function handleApiRoutes(req, res, pathname, method) {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', chunk => { body += chunk; });

    req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};

        // --- API ROUTE LOGIC ---
        if (method === 'GET' && pathname === '/api/cameras') {
            return res.writeHead(200).end(JSON.stringify(cameraConfig));
        }
        if (method === 'GET' && pathname === '/api/fingerprints') {
            return res.writeHead(200).end(JSON.stringify(fingerprintsDb));
        }
        if (method === 'GET' && pathname === '/api/recording-status') {
            const status = { isRecording: !!recordingProcess, camera: currentRecordingCamera, startTime: recordingStartTime };
            return res.writeHead(200).end(JSON.stringify(status));
        }
        if (method === 'GET' && pathname === '/api/recordings') {
            return fs.readdir(RECORDINGS_DIR, (err, files) => {
                if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not read recordings directory.' }));
                const videos = files.filter(f => f.endsWith('.mp4')).sort().reverse();
                return res.writeHead(200).end(JSON.stringify(videos));
            });
        }
        if (method === 'POST' && pathname === '/api/record/start') {
            startBufferedRecording(payload.cameraKey);
            return res.writeHead(200).end(JSON.stringify({ message: 'Recording started.' }));
        }
        if (method === 'POST' && pathname === '/api/record/stop') {
            stopBufferedRecording();
            return res.writeHead(200).end(JSON.stringify({ message: 'Recording stopped.' }));
        }
        if (method === 'POST' && pathname === '/api/match-event') {
            handleMatchEvent(payload.eventType, payload.cameraKey);
            return res.writeHead(200).end(JSON.stringify({ message: 'Event processed.' }));
        }
        if (method === 'POST' && pathname === '/api/fingerprints') {
            fingerprintsDb[payload.name] = payload.mfcc;
            return fs.writeFile(FINGERPRINTS_DB_PATH, JSON.stringify(fingerprintsDb, null, 2), (err) => {
                if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not save fingerprint' }));
                return res.writeHead(200).end(JSON.stringify({ success: true, name: payload.name }));
            });
        }
        // --- NEW ENDPOINT FOR INSTANT DISCONNECT ---
        if (method === 'POST' && pathname === '/api/stream/disconnect') {
            const { cameraKey } = payload;
            if (cameraKey) {
                console.log(`[API] Received explicit disconnect for camera: ${cameraKey}`);
                streamManager.cleanupCameraConnection(cameraKey);
            }
            return res.writeHead(202).end(JSON.stringify({ message: 'Disconnect signal received.'}));
        }

        return res.writeHead(404).end(JSON.stringify({ error: 'API endpoint not found.' }));
    });
}

function serveStaticFile(res, filePath, contentType) {
    fs.readFile(path.join(__dirname, filePath), (err, data) => {
        if (err) return res.writeHead(404).end('File not found');
        res.writeHead(200, { 'Content-Type': contentType }).end(data);
    });
}

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

process.on('SIGINT', () => {
    console.log('\nShutdown signal received...');
    if (recordingProcess) stopBufferedRecording();
    if (streamManager) streamManager.cleanup();
    process.exit(0);
});