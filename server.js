const http = require('http');
const request = require('request');
const fs = require('fs');
const path = require('path');
const url = 'url';
const { spawn } = require('child_process');

// --- Finalized StreamManager Combining Best of Both Versions ---
class StreamManager {
    constructor() {
        this.streams = new Map();
        // Inspired by your old code: using a 30-second idle timeout.
        this.idleTimeout = 30000;
    }

    proxyStream(req, res, cameraKey, cameraConfig) {
        console.log(`[STREAM] Proxy request for camera: ${cameraKey}`);
        const cameraDetails = cameraConfig[cameraKey];
        if (!cameraDetails) {
            console.error(`[STREAM] Camera not found: ${cameraKey}`);
            return this._safeRespond(res, 404, 'Camera not found');
        }

        console.log(`[STREAM] Camera details for ${cameraKey}:`, cameraDetails);

        // If stream doesn't exist or is in ERROR state, create a fresh one
        if (!this.streams.has(cameraKey) || this.streams.get(cameraKey).state === 'ERROR') {
            this.streams.set(cameraKey, this._createCameraStream(cameraKey, cameraDetails));
        }
        const stream = this.streams.get(cameraKey);

        // If a previous upstreamRequest exists (from a failed connection), clean up before adding client
        if (stream.state === 'ERROR' || stream.upstreamRequest === null) {
            // Recreate stream
            this.streams.set(cameraKey, this._createCameraStream(cameraKey, cameraDetails));
        }
        const currentStream = this.streams.get(cameraKey);

        // Add client
        currentStream.clients.add(res);
        console.log(`[STREAM] Client connected to ${cameraKey}. Total clients: ${currentStream.clients.size}`);

        // Cancel any pending cleanup
        if (currentStream.cleanupTimeout) {
            clearTimeout(currentStream.cleanupTimeout);
            currentStream.cleanupTimeout = null;
        }

        // Remove client on close
        req.on('close', () => {
            currentStream.clients.delete(res);
            console.log(`[STREAM] Client disconnected from ${cameraKey}. Remaining clients: ${currentStream.clients.size}`);
            if (currentStream.clients.size === 0) {
                this._scheduleCleanup(currentStream);
            }
        });

        // Set headers for the stream
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // If stream is CONNECTED, send headers immediately
        if (currentStream.state === 'CONNECTED' && currentStream.headers) {
            res.writeHead(200, currentStream.headers);
        } else if (currentStream.state === 'ERROR') {
            this._safeRespond(res, 502, 'Camera stream has failed');
            return;
        }

        // If stream is not connected, always start a new connection
        if (currentStream.state === 'IDLE' || currentStream.state === 'ERROR') {
            this._connectToCamera(currentStream);
        }
    }

    _createCameraStream(cameraKey, cameraDetails) {
        return {
            key: cameraKey,
            details: cameraDetails,
            state: 'IDLE', // IDLE, CONNECTING, CONNECTED, ERROR
            clients: new Set(),
            upstreamRequest: null,
            headers: null,
            cleanupTimeout: null,
        };
    }
    
    _connectToCamera(stream) {
        stream.state = 'CONNECTING';
        const cameraUrl = `http://${stream.details.ip}:${stream.details.port}${stream.details.path}`;
        console.log(`[STREAM] Connecting to camera: ${stream.key} at ${cameraUrl}`);
        
        const upstreamRequest = request.get({ 
            url: cameraUrl, 
            timeout: 15000,
            headers: {
                'User-Agent': 'FRC-Replay-System/1.0'
            }
        });
        stream.upstreamRequest = upstreamRequest;

        upstreamRequest.on('response', (response) => {
            console.log(`[STREAM] Response from ${stream.key}: ${response.statusCode}`);
            if (response.statusCode !== 200) {
                stream.state = 'ERROR';
                this._broadcastError(stream, `Camera returned status ${response.statusCode}`);
                return;
            }
            
            console.log(`[STREAM] Successfully connected to camera: ${stream.key}`);
            stream.state = 'CONNECTED';
            stream.headers = {
                'Content-Type': response.headers['content-type'] || 'video/x-flv',
                'Transfer-Encoding': 'chunked'
            };

            // Send headers to all waiting clients
            for (const clientRes of stream.clients) {
                if (!clientRes.headersSent) {
                    try {
                        clientRes.writeHead(200, stream.headers);
                    } catch (e) {
                        console.warn(`[STREAM] Failed to write headers for client on ${stream.key}:`, e.message);
                    }
                }
            }

            response.on('data', (chunk) => {
                // Broadcast data chunk to every connected client
                const clientsToRemove = [];
                for (const clientRes of stream.clients) {
                    if (clientRes.writable) {
                        clientRes.write(chunk, (err) => {
                            // If writing fails, the client has disconnected abruptly.
                            if (err) {
                                console.log(`[STREAM] Write error for client on ${stream.key}, scheduling removal.`);
                                clientsToRemove.push(clientRes);
                            }
                        });
                    } else {
                        clientsToRemove.push(clientRes);
                    }
                }
                // Clean up any clients that failed to write
                if (clientsToRemove.length > 0) {
                     clientsToRemove.forEach(client => stream.clients.delete(client));
                     if(stream.clients.size === 0) this._scheduleCleanup(stream);
                }
            });

            response.on('end', () => {
                console.log(`[STREAM] Camera stream ended: ${stream.key}`);
                this._cleanupStream(stream, `Camera stream ended: ${stream.key}`);
            });
            response.on('error', (err) => {
                console.error(`[STREAM] Camera stream error for ${stream.key}:`, err);
                this._cleanupStream(stream, `Camera stream error: ${err.message}`);
            });
        });
        
        upstreamRequest.on('error', (err) => {
            console.error(`[STREAM] Connection error for ${stream.key}:`, err);
            stream.state = 'ERROR';
            this._broadcastError(stream, err.message);
            this._cleanupStream(stream, `Connection error: ${err.message}`);
        });
    }

    _scheduleCleanup(stream) {
        if (stream.clients.size > 0) return;
        console.log(`[STREAM] No clients for ${stream.key}. Cleaning up immediately.`);
        this._cleanupStream(stream, `No clients left for ${stream.key}.`);
    }
    
    _cleanupStream(stream, reason) {
        console.log(`[STREAM] Cleaning up connection for ${stream.key}. Reason: ${reason}`);
        if (stream.cleanupTimeout) clearTimeout(stream.cleanupTimeout);
        stream.cleanupTimeout = null;
        
        if (stream.upstreamRequest) {
            try {
                stream.upstreamRequest.abort();
            } catch (e) {
                console.warn(`[STREAM] Error aborting request for ${stream.key}:`, e.message);
            }
        }

        stream.clients.forEach(res => this._safeRespond(res, 503, 'Stream disconnected by server.'));
        
        // Reset the stream state
        this.streams.set(stream.key, this._createCameraStream(stream.key, stream.details));
    }

    _broadcastError(stream, message) {
        console.error(`[STREAM] Broadcasting error for ${stream.key}: ${message}`);
        for (const clientRes of stream.clients) {
            this._safeRespond(clientRes, 502, `Camera error: ${message}`);
        }
        stream.clients.clear();
    }
    
    _safeRespond(res, statusCode, message) {
        if (!res.headersSent && !res.writableEnded) {
            try {
                res.statusCode = statusCode;
                res.end(message);
            } catch (e) {
                console.warn(`[STREAM] Error sending response:`, e.message);
            }
        }
    }
    
    shutdown() {
        console.log('[STREAM] Shutting down StreamManager...');
        for (const stream of this.streams.values()) {
            this._cleanupStream(stream, 'Server shutdown.');
        }
        this.streams.clear();
    }
}

// --- Configuration ---
const CONFIG_PATH = './config.json';
const FINGERPRINTS_DB_PATH = './fingerprints.json';
const THRESHOLD_PATH = './threshold.json';
const MATCH_STATE_PATH = './match_state.json';
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const PORT = 3000;
const MATCH_DURATION_MS = 155000; 

let cameraConfig, fingerprintsDb = {};
let recordingProcesses = new Map();
let matchStopTimeout = null;
let gameState = 'WAITING'; // 'WAITING', 'RECORDING'
let currentMatchNumber = 1;
let matchStartTime = null;
let matchEndedBy = 'timer'; // 'timer' or 'manual'
const streamManager = new StreamManager();

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

// Load match state on startup
try {
    if (fs.existsSync(MATCH_STATE_PATH)) {
        const matchState = JSON.parse(fs.readFileSync(MATCH_STATE_PATH));
        currentMatchNumber = matchState.currentMatchNumber || 1;
        console.log(`Loaded match state: Next match will be #${currentMatchNumber}`);
    }
} catch (error) {
    console.error('Could not read match state, starting from match 1');
    currentMatchNumber = 1;
}

// Save match state
function saveMatchState() {
    try {
        fs.writeFileSync(MATCH_STATE_PATH, JSON.stringify({
            currentMatchNumber,
            lastUpdate: new Date().toISOString()
        }));
    } catch (error) {
        console.error('Failed to save match state:', error);
    }
}

try {
    cameraConfig = JSON.parse(fs.readFileSync(CONFIG_PATH)).cameras;
    console.log('Camera configuration loaded:', Object.keys(cameraConfig));
} catch (error) {
    console.error(`FATAL: Could not read or parse ${CONFIG_PATH}. Exiting.`, error);
    process.exit(1);
}

try {
    if (fs.existsSync(FINGERPRINTS_DB_PATH)) {
        fingerprintsDb = JSON.parse(fs.readFileSync(FINGERPRINTS_DB_PATH));
        console.log(`Audio fingerprints database loaded: ${Object.keys(fingerprintsDb).length} fingerprints`);
    }
} catch (error) {
    console.error('Could not read or parse fingerprints.json.', error);
}

// --- Enhanced Recording & Event Functions ---
function startRecording(cameraKey) {
    if (recordingProcesses.has(cameraKey)) {
        console.log(`[RECORDING] Recording already active for ${cameraKey}`);
        return;
    }
    
    const camera = cameraConfig[cameraKey];
    if (!camera) return console.error(`[RECORDING] Error: Camera key "${cameraKey}" not found.`);
    
    const streamUrl = `http://${camera.ip}:${camera.port}${camera.path}`;
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
    
    // Enhanced filename format: match{number}_{camera}_{timestamp}.mp4
    const outputPath = path.join(RECORDINGS_DIR, `match${currentMatchNumber}_${cameraKey}_${timestamp}.mp4`);
    console.log(`[RECORDING] Starting recording for "${camera.name}" to ${outputPath}`);
    
    const ffmpegArgs = [
        '-y', '-i', streamUrl, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', 
        '-movflags', '+faststart', '-fflags', '+genpts', 
        '-timeout', '10000000', '-reconnect', '1', '-reconnect_streamed', '1',
        outputPath
    ];
    
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { shell: true, stdio: 'pipe' });
    recordingProcesses.set(cameraKey, { process: ffmpegProcess, outputPath, startTime: Date.now() });

    ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('time=')) return;
        console.log(`[FFMPEG-${cameraKey}] ${output.substring(0, 200)}`);
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`[FFMPEG-${cameraKey}] Process exited with code ${code}.`);
        const recordingInfo = recordingProcesses.get(cameraKey);
        if (recordingInfo) {
            const duration = (Date.now() - recordingInfo.startTime) / 1000;
            console.log(`[RECORDING] Completed: ${recordingInfo.outputPath} (${duration.toFixed(1)}s)`);
        }
        recordingProcesses.delete(cameraKey);
    });
    
    ffmpegProcess.on('error', (err) => {
        console.error(`[FFMPEG-${cameraKey}] Failed to start:`, err);
        recordingProcesses.delete(cameraKey);
    });
}

function stopAllRecordings() {
    if (recordingProcesses.size === 0) return;
    console.log('[RECORDING] Stopping all recordings...');
    
    for (const [cameraKey, recordingInfo] of recordingProcesses.entries()) {
        try {
            recordingInfo.process.stdin.write('q\n');
        } catch (err) {
            recordingInfo.process.kill('SIGTERM');
        }
    }
    recordingProcesses.clear();
}

function handleMatchEvent(eventType, payload = {}) {
    const { matchNumber, isManual } = payload;
    
    if (eventType === 'MATCH_START') {
        if (gameState === 'RECORDING') return;
        if (matchStopTimeout) clearTimeout(matchStopTimeout);
        
        console.log(`[EVENT] Match ${currentMatchNumber} start triggered ${isManual ? '(Manual)' : '(Audio Detection)'}.`);
        gameState = 'RECORDING';
        matchStartTime = Date.now();
        matchEndedBy = 'timer'; // Default assumption
        
        Object.keys(cameraConfig).forEach(startRecording);
        
        matchStopTimeout = setTimeout(() => {
            console.log(`[EVENT] Match ${currentMatchNumber} timer finished. Stopping recordings.`);
            matchEndedBy = 'timer';
            stopAllRecordings();
            gameState = 'WAITING';
            matchStopTimeout = null;
            
            // Increment match number for next match
            currentMatchNumber++;
            saveMatchState();
        }, MATCH_DURATION_MS);

    } else if (eventType === 'MATCH_ABORT') {
        console.log(`[EVENT] Match ${currentMatchNumber} abort triggered ${isManual ? '(Manual)' : '(System)'}.`);
        gameState = 'WAITING';
        matchEndedBy = isManual ? 'manual' : 'system';
        
        if (matchStopTimeout) clearTimeout(matchStopTimeout);
        matchStopTimeout = null;
        stopAllRecordings();
        
        // Only increment if this was actually recording
        if (matchStartTime) {
            currentMatchNumber++;
            saveMatchState();
            matchStartTime = null;
        }
    }
}

// --- HTTP Server with Enhanced API ---
const server = http.createServer((req, res) => {
    const parsedUrl = require('url').parse(req.url, true);
    const { pathname } = parsedUrl;
    const { method } = req;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') return res.writeHead(200).end();
    
    if (pathname === '/stream') {
        return streamManager.proxyStream(req, res, parsedUrl.query.camera, cameraConfig);
    }
    
    if (pathname.startsWith('/api/')) return handleApiRoutes(req, res, pathname, method);
    
    if (method === 'GET') {
        const staticFiles = {
            '/': 'index.html', '/index.html': 'index.html',
            '/fingerprinter': 'fingerprinter.html', '/recordings': 'recordings.html'
        };
        if (staticFiles[pathname]) {
            return serveStaticFile(res, staticFiles[pathname], 'text/html');
        }
        if (pathname.match(/^\/recordings\/.+\.mp4$/)) {
            return serveStaticFile(res, pathname.substring(1), 'video/mp4');
        }
    }
    res.writeHead(404).end('Not Found');
});

function handleApiRoutes(req, res, pathname, method) {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const payload = body ? JSON.parse(body) : {};

            if (method === 'GET' && pathname === '/api/cameras') {
                console.log('[API] Returning camera config:', Object.keys(cameraConfig));
                return res.writeHead(200).end(JSON.stringify(cameraConfig));
            }
            
            if (method === 'GET' && pathname === '/api/fingerprints') {
                return res.writeHead(200).end(JSON.stringify(fingerprintsDb));
            }
            
            if (method === 'GET' && pathname === '/api/recordings') {
                return fs.readdir(RECORDINGS_DIR, (err, files) => {
                    if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not read recordings directory.' }));
                    const videos = files.filter(f => f.endsWith('.mp4')).sort().reverse();
                    res.writeHead(200).end(JSON.stringify(videos));
                });
            }
            
            if (method === 'GET' && pathname === '/api/threshold') {
                return fs.readFile(THRESHOLD_PATH, 'utf8', (err, data) => {
                    if (err) return res.writeHead(200).end(JSON.stringify({ threshold: 20 }));
                    res.writeHead(200).end(data);
                });
            }
            
            if (method === 'GET' && pathname === '/api/match-state') {
                return res.writeHead(200).end(JSON.stringify({
                    currentMatchNumber,
                    gameState,
                    isRecording: gameState === 'RECORDING',
                    matchEndedBy
                }));
            }
            
            // Video info endpoint for recordings page
            if (method === 'GET' && pathname.startsWith('/api/video-info/')) {
                const filename = decodeURIComponent(pathname.split('/api/video-info/')[1]);
                const filePath = path.join(RECORDINGS_DIR, filename);
                
                return fs.stat(filePath, (err, stats) => {
                    if (err) return res.writeHead(404).end(JSON.stringify({ error: 'File not found' }));
                    
                    res.writeHead(200).end(JSON.stringify({
                        size: stats.size,
                        created: stats.birthtime,
                        modified: stats.mtime
                    }));
                });
            }
            
            if (method === 'POST' && pathname === '/api/threshold') {
                return fs.writeFile(THRESHOLD_PATH, JSON.stringify(payload), (err) => {
                    if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not save threshold' }));
                    res.writeHead(200).end(JSON.stringify({ success: true }));
                });
            }
            
            if (method === 'POST' && pathname === '/api/match-event') {
                handleMatchEvent(payload.eventType, payload);
                return res.writeHead(200).end(JSON.stringify({ 
                    success: true, 
                    gameState: gameState,
                    currentMatchNumber,
                    matchEndedBy
                }));
            }
            
            if (method === 'POST' && pathname === '/api/fingerprints') {
                const { name, mfcc, description } = payload;
                fingerprintsDb[name] = {
                    mfcc: mfcc,
                    description: description || null,
                    created: new Date().toISOString()
                };
                
                fs.writeFile(FINGERPRINTS_DB_PATH, JSON.stringify(fingerprintsDb, null, 2), (err) => {
                    if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not save fingerprint' }));
                    console.log(`[FINGERPRINT] Saved: ${name} (${mfcc.length} coefficients)`);
                    res.writeHead(200).end(JSON.stringify({ success: true, name: name }));
                });
                return;
            }
            
            // Delete fingerprint endpoint
            if (method === 'DELETE' && pathname.startsWith('/api/fingerprints/')) {
                const fingerprintName = decodeURIComponent(pathname.split('/api/fingerprints/')[1]);
                
                if (fingerprintsDb[fingerprintName]) {
                    delete fingerprintsDb[fingerprintName];
                    
                    fs.writeFile(FINGERPRINTS_DB_PATH, JSON.stringify(fingerprintsDb, null, 2), (err) => {
                        if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not delete fingerprint' }));
                        console.log(`[FINGERPRINT] Deleted: ${fingerprintName}`);
                        res.writeHead(200).end(JSON.stringify({ success: true, deleted: fingerprintName }));
                    });
                } else {
                    res.writeHead(404).end(JSON.stringify({ error: 'Fingerprint not found' }));
                }
                return;
            }
            
            res.writeHead(404).end(JSON.stringify({ error: 'API endpoint not found.' }));
        } catch (error) {
            console.error('API Error:', error);
            res.writeHead(500).end(JSON.stringify({ error: 'Server error processing request' }));
        }
    });
}

function serveStaticFile(res, filePath, contentType) {
    fs.readFile(path.join(__dirname, filePath), (err, data) => {
        if (err) return res.writeHead(404).end('File not found');
        res.writeHead(200, { 'Content-Type': contentType }).end(data);
    });
}

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Next match will be recorded as: match${currentMatchNumber}_[camera]_[timestamp].mp4`);
});

function shutdown() {
    console.log('\nShutdown signal received...');
    stopAllRecordings();
    saveMatchState();
    streamManager.shutdown();
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
    
    setTimeout(() => {
        console.error('Forcing shutdown.');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);