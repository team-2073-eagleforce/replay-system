const http = require('http');
const request = require('request');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

// --- Configuration ---
const CONFIG_PATH = './config.json';
const FINGERPRINTS_DB_PATH = './fingerprints.json';
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const PORT = 3000;

// Recording state management
let cameraConfig;
let fingerprintsDb = {};
let recordingProcess = null;
let currentRecordingCamera = null;
let recordingStartTime = null;
let recordingBuffer = 5; // 5 seconds buffer before and after events

// Create recordings directory if it doesn't exist
if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR);
    console.log(`Created recordings directory at: ${RECORDINGS_DIR}`);
}

try {
    const configFile = fs.readFileSync(CONFIG_PATH);
    cameraConfig = JSON.parse(configFile).cameras;
    console.log('Camera configuration loaded.');
} catch (error) {
    console.error(`FATAL: Could not read or parse ${CONFIG_PATH}.`);
    process.exit(1);
}

try {
    if (fs.existsSync(FINGERPRINTS_DB_PATH)) {
        const dbFile = fs.readFileSync(FINGERPRINTS_DB_PATH);
        fingerprintsDb = JSON.parse(dbFile);
        console.log('Audio fingerprints database loaded.');
    }
} catch (error) {
    console.error('Could not read or parse fingerprints.json.', error);
}

// --- Enhanced Recording Functions ---
function startBufferedRecording(cameraKey) {
    if (recordingProcess) {
        console.log('[RECORDING] Recording already in progress, skipping start request.');
        return;
    }

    const camera = cameraConfig[cameraKey];
    if (!camera) {
        console.error(`[RECORDING] Error: Camera key "${cameraKey}" not found.`);
        return;
    }

    const streamUrl = `http://${camera.ip}:${camera.port}${camera.path}`;
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
    const outputPath = path.join(RECORDINGS_DIR, `match-${timestamp}.mp4`);

    console.log(`[RECORDING] Starting buffered recording for "${camera.name}" to ${outputPath}`);

    // Windows-optimized ffmpeg arguments
    const ffmpegArgs = [
        '-y', // Overwrite output file without asking
        '-i', streamUrl,
        '-c:v', 'libx264', // Use libx264 instead of copy for better compatibility
        '-preset', 'ultrafast', // Fast encoding for real-time
        '-crf', '23', // Good quality/size balance
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'mp4',
        '-movflags', '+faststart', // Optimize for streaming
        '-avoid_negative_ts', 'make_zero', // Handle timing issues
        '-fflags', '+genpts', // Generate presentation timestamps
        '-timeout', '10000000', // 10 second timeout for network issues
        outputPath
    ];

    console.log(`[FFMPEG] Starting command: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Use spawn with shell: true for Windows compatibility
    recordingProcess = spawn('ffmpeg', ffmpegArgs, { 
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    currentRecordingCamera = cameraKey;
    recordingStartTime = Date.now();

    recordingProcess.stdout.on('data', (data) => {
        console.log(`[FFMPEG] stdout: ${data.toString().substring(0, 100)}...`);
    });

    recordingProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Only log important ffmpeg messages
        if (output.includes('error') || output.includes('Error') || output.includes('frame=')) {
            console.log(`[FFMPEG] ${output.substring(0, 200)}...`);
        }
    });

    recordingProcess.on('close', (code) => {
        console.log(`[FFMPEG] Process exited with code ${code}.`);
        recordingProcess = null;
        currentRecordingCamera = null;
        recordingStartTime = null;
    });

    recordingProcess.on('error', (err) => {
        console.error('[FFMPEG] Failed to start ffmpeg process. Ensure ffmpeg is installed and in PATH:', err);
        recordingProcess = null;
        currentRecordingCamera = null;
        recordingStartTime = null;
    });
}

function stopBufferedRecording() {
    if (recordingProcess) {
        console.log('[RECORDING] Stopping buffered recording...');
        
        // Send 'q' command to ffmpeg for graceful shutdown
        try {
            recordingProcess.stdin.write('q\n');
        } catch (err) {
            console.log('[FFMPEG] Could not send quit command, killing process...');
            recordingProcess.kill('SIGTERM');
        }
        
        // Force kill after 5 seconds if graceful shutdown fails
        setTimeout(() => {
            if (recordingProcess) {
                console.log('[FFMPEG] Force killing process...');
                recordingProcess.kill('SIGKILL');
            }
        }, 5000);
    }
}

// --- Event-based Recording Control ---
function handleMatchEvent(eventType) {
    const selectedCamera = getCurrentSelectedCamera(); // You'll need to implement this
    
    switch (eventType) {
        case 'MATCH_START':
            console.log('[EVENT] Match start detected - starting recording with buffer');
            if (selectedCamera) {
                startBufferedRecording(selectedCamera);
            }
            break;
            
        case 'MATCH_END':
            console.log('[EVENT] Match end detected - stopping recording after buffer');
            // Add 5 second delay before stopping to capture the buffer
            setTimeout(() => {
                stopBufferedRecording();
            }, recordingBuffer * 1000);
            break;
            
        case 'MATCH_ABORT':
            console.log('[EVENT] Match aborted - stopping recording immediately');
            stopBufferedRecording();
            break;
    }
}

// Helper function to get current selected camera (you'll need to track this)
function getCurrentSelectedCamera() {
    // For now, return the first camera key as default
    // You should modify this to track the currently selected camera
    return Object.keys(cameraConfig)[0];
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(200).end();
        return;
    }

    // --- API Routes ---
    if (pathname.startsWith('/api/')) {
        handleApiRoutes(req, res, pathname, method);
        return;
    }
    
    // --- Page & File Routes ---
    if (method === 'GET') {
        switch (pathname) {
            case '/':
            case '/index.html':
                serveIndexWithConfig(res);
                break;
            case '/fingerprinter':
                serveStaticFile(res, 'fingerprinter.html', 'text/html');
                break;
            case '/recordings':
                serveStaticFile(res, 'recordings.html', 'text/html');
                break;
            case (pathname.match(/^\/recordings\/.+\.mp4$/) || {}).input:
                serveStaticFile(res, pathname.substring(1), 'video/mp4');
                break;
            case '/stream':
                proxyStream(req, res, parsedUrl.query);
                break;
            default:
                res.writeHead(404).end('Not Found');
        }
    } else {
        res.writeHead(404).end('Not Found');
    }
});

function handleApiRoutes(req, res, pathname, method) {
    res.setHeader('Content-Type', 'application/json');
    
    if (method === 'POST' && pathname === '/api/record/start') {
        console.log('[API] Manual start recording request');
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { cameraKey } = JSON.parse(body);
                startBufferedRecording(cameraKey);
                res.writeHead(200).end(JSON.stringify({ message: 'Recording started.' }));
            } catch (err) {
                res.writeHead(400).end(JSON.stringify({ error: 'Invalid request body' }));
            }
        });
    } 
    else if (method === 'POST' && pathname === '/api/record/stop') {
        console.log('[API] Manual stop recording request');
        stopBufferedRecording();
        res.writeHead(200).end(JSON.stringify({ message: 'Recording stopped.' }));
    }
    else if (method === 'POST' && pathname === '/api/match-event') {
        console.log('[API] Match event received');
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { eventType, cameraKey } = JSON.parse(body);
                if (cameraKey) {
                    currentRecordingCamera = cameraKey;
                }
                handleMatchEvent(eventType);
                res.writeHead(200).end(JSON.stringify({ message: 'Event processed.' }));
            } catch (err) {
                res.writeHead(400).end(JSON.stringify({ error: 'Invalid request body' }));
            }
        });
    }
    else if (method === 'GET' && pathname === '/api/recording-status') {
        const status = {
            isRecording: recordingProcess !== null,
            camera: currentRecordingCamera,
            startTime: recordingStartTime
        };
        res.writeHead(200).end(JSON.stringify(status));
    }
    else if (method === 'GET' && pathname === '/api/recordings') {
        fs.readdir(RECORDINGS_DIR, (err, files) => {
            if (err) {
                res.writeHead(500).end(JSON.stringify({ error: 'Could not read recordings directory.' }));
                return;
            }
            const videoFiles = files.filter(file => file.endsWith('.mp4')).sort().reverse();
            res.writeHead(200).end(JSON.stringify(videoFiles));
        });
    } 
    else if (method === 'GET' && pathname === '/api/fingerprints') {
        res.writeHead(200).end(JSON.stringify(fingerprintsDb));
    } 
    else if (method === 'POST' && pathname === '/api/fingerprints') {
        saveFingerprint(req, res);
    } 
    else {
        res.writeHead(404).end(JSON.stringify({ error: 'API endpoint not found.' }));
    }
}

// --- Helper functions ---
function serveIndexWithConfig(res) {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, htmlData) => {
        if (err) { 
            res.writeHead(500).end('Error loading index.html'); 
            return; 
        }
        let optionsHtml = '<option value="">-- Select a Camera --</option>';
        for (const key in cameraConfig) {
            const camera = cameraConfig[key];
            if (camera && camera.name) {
                optionsHtml += `<option value="${key}">${camera.name}</option>`;
            }
        }
        const finalHtml = htmlData.replace('<!-- CAMERA_OPTIONS_PLACEHOLDER -->', optionsHtml);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(finalHtml);
    });
}

function serveStaticFile(res, filePath, contentType) {
    const fullPath = path.join(__dirname, filePath);
    fs.readFile(fullPath, (err, data) => {
        if (err) { 
            res.writeHead(404).end('File not found'); 
            return; 
        }
        res.writeHead(200, { 'Content-Type': contentType }).end(data);
    });
}

function saveFingerprint(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { name, mfcc } = JSON.parse(body);
            fingerprintsDb[name] = mfcc;
            fs.writeFile(FINGERPRINTS_DB_PATH, JSON.stringify(fingerprintsDb, null, 2), (err) => {
                if (err) { 
                    res.writeHead(500).end(JSON.stringify({ error: 'Could not save fingerprint' })); 
                    return; 
                }
                res.writeHead(200).end(JSON.stringify({ success: true, name }));
            });
        } catch (e) {
            res.writeHead(400).end(JSON.stringify({ error: 'Invalid request body' }));
        }
    });
}

function proxyStream(req, res, query) {
    const cameraKey = query.camera;
    const selectedCamera = cameraConfig[cameraKey];
    if (!selectedCamera) { 
        res.writeHead(404).end('Camera not found'); 
        return; 
    }
    const cameraUrl = `http://${selectedCamera.ip}:${selectedCamera.port}${selectedCamera.path}`;
    
    console.log(`[STREAM] Proxying stream from ${cameraUrl}`);
    
    const streamReq = request.get(cameraUrl);
    streamReq.on('error', (err) => {
        console.error(`[STREAM] Error proxying stream: ${err.message}`);
        res.writeHead(502).end();
    });
    streamReq.pipe(res);
}

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Recordings will be saved to: ${RECORDINGS_DIR}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    if (recordingProcess) {
        stopBufferedRecording();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    if (recordingProcess) {
        stopBufferedRecording();
    }
    process.exit(0);
});