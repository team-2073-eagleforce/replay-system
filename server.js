const http = require('http');
const request = require('request');
const fs = require('fs');
const path = require('path');
const url = 'url';
const { spawn } = require('child_process');

// --- Simple Audio Detector Class (Integrated) ---
class SimpleAudioDetector {
    constructor(fingerprintsDb, onMatchCallback) {
        // Your specific audio parameters
        this.sampleRate = 22050;
        this.frameSize = 1024;
        this.hopLength = 512;
        
        // From your analysis - exact frequency range where energy is concentrated
        this.targetFreqMin = 285;   // Your actual minimum
        this.targetFreqMax = 3207;  // Your actual maximum
        this.primaryBandMin = 2000; // High-mid band where most energy is
        this.primaryBandMax = 4000;
        
        // Your specific levels
        this.noiseFloor = -14.4;           // Your calculated noise floor
        this.confidenceThreshold = 0.70;   // Your confidence threshold
        this.rmsReference = -20.4;         // Your audio's RMS level
        
        // Detection stability - 5 second cooldown as requested
        this.cooldownPeriod = 5000; // 5 seconds
        this.lastDetectionTime = 0;
        this.consecutiveMatches = 2; // Require 2 consecutive matches
        this.matchHistory = [];
        
        // Processing state
        this.audioBuffer = [];
        this.fingerprintsDb = fingerprintsDb;
        this.onMatchCallback = onMatchCallback;
        this.isProcessing = false;
        this.audioProcess = null;
        
        // Wiener filter coefficients (simple noise reduction)
        this.noiseProfile = null;
        this.adaptationRate = 0.1;
        
        // AGC parameters
        this.agcEnabled = true;
        this.targetRMS = -20.0; // Target RMS level (close to your reference)
        this.agcGain = 1.0;
        this.agcAttack = 0.1;
        this.agcRelease = 0.01;
        
        console.log(`[DETECTOR] Initialized for frequency range: ${this.targetFreqMin}-${this.targetFreqMax}Hz`);
        console.log(`[DETECTOR] Primary detection band: ${this.primaryBandMin}-${this.primaryBandMax}Hz`);
        console.log(`[DETECTOR] Noise floor: ${this.noiseFloor}dB, Cooldown: ${this.cooldownPeriod}ms`);
    }

    startListening() {
        if (this.isProcessing) {
            console.log('[DETECTOR] Already listening');
            return;
        }

        this.isProcessing = true;
        this.lastDetectionTime = 0; // Reset cooldown
        
        console.log('[DETECTOR] Starting optimized audio capture...');
        
        // Start FFmpeg with specific preprocessing for your frequency range
        const ffmpegArgs = [
            '-f', 'alsa',                    // Audio input (change for your OS)
            '-i', 'default',                 // Default microphone
            '-ar', this.sampleRate.toString(),
            '-ac', '1',                      // Mono
            '-f', 'wav',
            '-acodec', 'pcm_s16le',
            
            // Optimized filters for your specific frequency range
            '-af', [
                `highpass=f=${this.targetFreqMin}`,        // Remove frequencies below 285Hz
                `lowpass=f=${this.targetFreqMax}`,         // Remove frequencies above 3207Hz
                `bandpass=f=${(this.primaryBandMin + this.primaryBandMax) / 2}:width_type=h:w=${this.primaryBandMax - this.primaryBandMin}`, // Emphasize 2-4kHz band
                'afftdn=nf=0.3',                           // Spectral noise reduction
                'compand=attacks=0.1:decays=0.2:points=-30/-30|-20/-15|-10/-5|0/0', // Dynamic range compression
                'volume=1.5'                               // Slight boost
            ].join(','),
            
            'pipe:1'
        ];

        this.audioProcess = spawn('ffmpeg', ffmpegArgs, { 
            stdio: ['ignore', 'pipe', 'pipe'] 
        });

        this.audioProcess.stdout.on('data', (chunk) => {
            this.processAudioData(chunk);
        });

        this.audioProcess.stderr.on('data', (data) => {
            const output = data.toString();
            // Only log errors, not status updates
            if (output.includes('Error') || output.includes('error')) {
                console.log(`[DETECTOR-FFMPEG] ${output.substring(0, 200)}`);
            }
        });

        this.audioProcess.on('close', (code) => {
            console.log(`[DETECTOR] Audio capture stopped (code: ${code})`);
            this.isProcessing = false;
        });

        this.audioProcess.on('error', (err) => {
            console.error('[DETECTOR] Failed to start audio capture:', err.message);
            this.isProcessing = false;
        });
    }

    stopListening() {
        if (this.audioProcess) {
            this.audioProcess.kill('SIGTERM');
            this.audioProcess = null;
        }
        this.isProcessing = false;
        this.audioBuffer = [];
        this.matchHistory = [];
        console.log('[DETECTOR] Stopped listening');
    }

    processAudioData(chunk) {
        // Convert buffer to 16-bit integers
        const samples = Array.from(new Int16Array(chunk.buffer));
        this.audioBuffer.push(...samples);
        
        // Process when we have enough samples
        if (this.audioBuffer.length >= this.frameSize * 2) {
            this.processFrame();
        }
    }

    processFrame() {
        if (this.audioBuffer.length < this.frameSize * 2) return;

        // Extract frame
        const samples = this.audioBuffer.splice(0, this.frameSize);
        
        // Convert to float and normalize
        let floatSamples = samples.map(s => s / 32768.0);
        
        // Apply Automatic Gain Control
        if (this.agcEnabled) {
            floatSamples = this.applyAGC(floatSamples);
        }
        
        // Apply Wiener filtering for noise reduction
        floatSamples = this.applyWienerFilter(floatSamples);
        
        // Calculate signal energy
        const energy = this.calculateRMSdB(floatSamples);
        
        // Skip if below noise floor
        if (energy < this.noiseFloor) {
            return;
        }
        
        // Check cooldown period
        const now = Date.now();
        if (now - this.lastDetectionTime < this.cooldownPeriod) {
            return; // Still in cooldown
        }

        // Extract MFCC features optimized for your frequency range
        const mfcc = this.extractOptimizedMFCC(floatSamples);
        
        // Compare against fingerprints
        let bestMatch = null;
        let bestConfidence = 0;

        for (const [name, fingerprint] of Object.entries(this.fingerprintsDb)) {
            if (!fingerprint.mfcc) continue;
            
            const confidence = this.calculateWeightedSimilarity(mfcc, fingerprint.mfcc);
            if (confidence > bestConfidence) {
                bestMatch = name;
                bestConfidence = confidence;
            }
        }

        // Track matches for stability
        this.matchHistory.push({
            match: bestMatch,
            confidence: bestConfidence,
            energy: energy,
            timestamp: now
        });

        // Keep only recent history
        if (this.matchHistory.length > 5) {
            this.matchHistory.shift();
        }

        // Check for stable detection
        if (bestConfidence > this.confidenceThreshold) {
            const recentMatches = this.matchHistory.slice(-this.consecutiveMatches);
            
            // Verify consecutive matches
            const stableMatch = recentMatches.length === this.consecutiveMatches && 
                               recentMatches.every(m => 
                                   m.match === bestMatch && 
                                   m.confidence > this.confidenceThreshold
                               );

            if (stableMatch) {
                console.log(`[DETECTOR] MATCH DETECTED: ${bestMatch}`);
                console.log(`[DETECTOR] Confidence: ${(bestConfidence * 100).toFixed(1)}%, Energy: ${energy.toFixed(1)}dB`);
                
                // Trigger callback
                if (this.onMatchCallback) {
                    this.onMatchCallback(bestMatch, bestConfidence, {
                        energy: energy,
                        detectionTime: now
                    });
                }
                
                // Set cooldown
                this.lastDetectionTime = now;
                this.matchHistory = []; // Clear history
                
                console.log(`[DETECTOR] Cooldown active for ${this.cooldownPeriod}ms`);
            }
        }
    }

    applyAGC(samples) {
        // Calculate current RMS
        const currentRMS = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
        const currentRMSdB = 20 * Math.log10(currentRMS + 1e-10);
        
        // Calculate desired gain
        const gainChange = this.targetRMS - currentRMSdB;
        const targetGain = Math.pow(10, gainChange / 20);
        
        // Smooth gain changes
        if (targetGain > this.agcGain) {
            this.agcGain += (targetGain - this.agcGain) * this.agcAttack;
        } else {
            this.agcGain += (targetGain - this.agcGain) * this.agcRelease;
        }
        
        // Limit gain to reasonable range
        this.agcGain = Math.max(0.1, Math.min(10.0, this.agcGain));
        
        // Apply gain
        return samples.map(s => s * this.agcGain);
    }

    applyWienerFilter(samples) {
        // Simple Wiener-like filtering - adapt to noise
        if (!this.noiseProfile) {
            // Initialize noise profile with first few frames
            this.noiseProfile = new Array(samples.length).fill(0);
        }
        
        // Update noise profile (simple approach)
        const energy = this.calculateRMSdB(samples);
        if (energy < this.noiseFloor + 3) { // Likely noise
            for (let i = 0; i < samples.length; i++) {
                this.noiseProfile[i] += this.adaptationRate * (samples[i] - this.noiseProfile[i]);
            }
        }
        
        // Apply noise reduction
        return samples.map((s, i) => s - 0.3 * this.noiseProfile[i]);
    }

    calculateRMSdB(samples) {
        const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
        return 20 * Math.log10(rms + 1e-10);
    }

    extractOptimizedMFCC(samples) {
        // Apply pre-emphasis (slight, since you have good high-frequency content)
        const emphasized = this.preEmphasis(samples, 0.8);
        
        // Hamming window
        const windowed = this.applyHammingWindow(emphasized);
        
        // FFT and focus on your frequency bands
        const spectrum = this.computeSpectrum(windowed);
        
        // Weight spectrum to emphasize your primary band (2-4kHz)
        const weightedSpectrum = this.applyFrequencyWeighting(spectrum);
        
        // Convert to MFCC
        return this.spectrumToMFCC(weightedSpectrum);
    }

    applyFrequencyWeighting(spectrum) {
        const weighted = new Array(spectrum.length);
        const freqStep = this.sampleRate / (2 * spectrum.length);
        
        for (let i = 0; i < spectrum.length; i++) {
            const freq = i * freqStep;
            let weight = 1.0;
            
            // Boost your primary band (2-4kHz where most energy is)
            if (freq >= this.primaryBandMin && freq <= this.primaryBandMax) {
                weight = 1.5; // 50% boost for primary detection band
            }
            // Slight boost for your full range
            else if (freq >= this.targetFreqMin && freq <= this.targetFreqMax) {
                weight = 1.2; // 20% boost for full detection range
            }
            // Reduce weight for frequencies outside your range
            else {
                weight = 0.8;
            }
            
            weighted[i] = spectrum[i] * weight;
        }
        
        return weighted;
    }

    preEmphasis(samples, alpha) {
        const result = [samples[0]];
        for (let i = 1; i < samples.length; i++) {
            result.push(samples[i] - alpha * samples[i - 1]);
        }
        return result;
    }

    applyHammingWindow(samples) {
        const n = samples.length;
        return samples.map((s, i) => s * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))));
    }

    computeSpectrum(samples) {
        // Simplified FFT - use a proper library in production
        const spectrum = new Array(samples.length / 2);
        for (let k = 0; k < spectrum.length; k++) {
            let real = 0, imag = 0;
            for (let n = 0; n < samples.length; n++) {
                const angle = -2 * Math.PI * k * n / samples.length;
                real += samples[n] * Math.cos(angle);
                imag += samples[n] * Math.sin(angle);
            }
            spectrum[k] = Math.sqrt(real * real + imag * imag);
        }
        return spectrum;
    }

    spectrumToMFCC(spectrum) {
        const numCoeffs = 13;
        const mfcc = [];
        
        for (let i = 0; i < numCoeffs; i++) {
            let coeff = 0;
            for (let j = 0; j < spectrum.length; j++) {
                coeff += Math.log(spectrum[j] + 1e-10) * Math.cos(Math.PI * i * (j + 0.5) / spectrum.length);
            }
            mfcc.push(coeff / spectrum.length);
        }
        
        return mfcc;
    }

    calculateWeightedSimilarity(mfcc1, mfcc2) {
        if (!mfcc1 || !mfcc2 || mfcc1.length !== mfcc2.length) return 0;
        
        // Weight lower coefficients more heavily (they contain most important info)
        // Based on your analysis showing concentrated frequency content
        const weights = mfcc1.map((_, i) => {
            if (i < 3) return 1.5;      // High weight for first 3 coefficients
            if (i < 6) return 1.2;      // Medium-high weight for next 3
            return 1.0;                 // Normal weight for rest
        });
        
        let distance = 0;
        let weightSum = 0;
        
        for (let i = 0; i < mfcc1.length; i++) {
            const diff = mfcc1[i] - mfcc2[i];
            distance += weights[i] * diff * diff;
            weightSum += weights[i];
        }
        
        distance = Math.sqrt(distance / weightSum);
        
        // Convert to similarity score, adjusted for your confidence threshold
        return Math.exp(-distance * 1.8); // Slightly more sensitive than default
    }

    // Status and debugging methods
    getStatus() {
        return {
            isProcessing: this.isProcessing,
            cooldownRemaining: Math.max(0, this.cooldownPeriod - (Date.now() - this.lastDetectionTime)),
            recentMatches: this.matchHistory.length,
            currentGain: this.agcGain?.toFixed(2),
            parameters: {
                frequencyRange: `${this.targetFreqMin}-${this.targetFreqMax}Hz`,
                primaryBand: `${this.primaryBandMin}-${this.primaryBandMax}Hz`,
                noiseFloor: `${this.noiseFloor}dB`,
                confidenceThreshold: this.confidenceThreshold,
                cooldownPeriod: `${this.cooldownPeriod}ms`
            }
        };
    }
}

// --- Finalized StreamManager (Your existing code unchanged) ---
class StreamManager {
    constructor() {
        this.streams = new Map();
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

        if (!this.streams.has(cameraKey) || this.streams.get(cameraKey).state === 'ERROR') {
            this.streams.set(cameraKey, this._createCameraStream(cameraKey, cameraDetails));
        }
        const stream = this.streams.get(cameraKey);

        if (stream.state === 'ERROR' || stream.upstreamRequest === null) {
            this.streams.set(cameraKey, this._createCameraStream(cameraKey, cameraDetails));
        }
        const currentStream = this.streams.get(cameraKey);

        currentStream.clients.add(res);
        console.log(`[STREAM] Client connected to ${cameraKey}. Total clients: ${currentStream.clients.size}`);

        if (currentStream.cleanupTimeout) {
            clearTimeout(currentStream.cleanupTimeout);
            currentStream.cleanupTimeout = null;
        }

        req.on('close', () => {
            currentStream.clients.delete(res);
            console.log(`[STREAM] Client disconnected from ${cameraKey}. Remaining clients: ${currentStream.clients.size}`);
            if (currentStream.clients.size === 0) {
                this._scheduleCleanup(currentStream);
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        if (currentStream.state === 'CONNECTED' && currentStream.headers) {
            res.writeHead(200, currentStream.headers);
        } else if (currentStream.state === 'ERROR') {
            this._safeRespond(res, 502, 'Camera stream has failed');
            return;
        }

        if (currentStream.state === 'IDLE' || currentStream.state === 'ERROR') {
            this._connectToCamera(currentStream);
        }
    }

    _createCameraStream(cameraKey, cameraDetails) {
        return {
            key: cameraKey,
            details: cameraDetails,
            state: 'IDLE',
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
                const clientsToRemove = [];
                for (const clientRes of stream.clients) {
                    if (clientRes.writable) {
                        clientRes.write(chunk, (err) => {
                            if (err) {
                                console.log(`[STREAM] Write error for client on ${stream.key}, scheduling removal.`);
                                clientsToRemove.push(clientRes);
                            }
                        });
                    } else {
                        clientsToRemove.push(clientRes);
                    }
                }
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

// --- Configuration (Your existing code) ---
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
let gameState = 'WAITING';
let currentMatchNumber = 1;
let currentMatchType = 'practice';
let matchStartTime = null;
let matchEndedBy = 'timer';
const streamManager = new StreamManager();

// --- NEW: Audio Detection Variables ---
let audioDetector = null;
let audioDetectionActive = false;

// Match type configurations (Your existing code)
const MATCH_TYPES = {
    practice: { label: 'Practice', prefix: 'P' },
    quals: { label: 'Qualifications', prefix: 'Q' },
    semifinals: { label: 'Semi-Finals', prefix: 'SF' },
    finals: { label: 'Finals', prefix: 'F' }
};

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

// Load match state on startup (Your existing code)
try {
    if (fs.existsSync(MATCH_STATE_PATH)) {
        const matchState = JSON.parse(fs.readFileSync(MATCH_STATE_PATH));
        currentMatchNumber = matchState.currentMatchNumber || 1;
        currentMatchType = matchState.currentMatchType || 'practice';
        console.log(`Loaded match state: Next match will be ${MATCH_TYPES[currentMatchType].prefix}${currentMatchNumber}`);
    }
} catch (error) {
    console.error('Could not read match state, starting from P1');
    currentMatchNumber = 1;
    currentMatchType = 'practice';
}

// Save match state (Your existing function)
function saveMatchState() {
    try {
        fs.writeFileSync(MATCH_STATE_PATH, JSON.stringify({
            currentMatchNumber,
            currentMatchType,
            lastUpdate: new Date().toISOString()
        }));
    } catch (error) {
        console.error('Failed to save match state:', error);
    }
}

// Load camera config (Your existing code)
try {
    cameraConfig = JSON.parse(fs.readFileSync(CONFIG_PATH)).cameras;
    console.log('Camera configuration loaded:', Object.keys(cameraConfig));
} catch (error) {
    console.error(`FATAL: Could not read or parse ${CONFIG_PATH}. Exiting.`, error);
    process.exit(1);
}

// Load fingerprints and initialize audio detector (MODIFIED)
try {
    if (fs.existsSync(FINGERPRINTS_DB_PATH)) {
        fingerprintsDb = JSON.parse(fs.readFileSync(FINGERPRINTS_DB_PATH));
        console.log(`Audio fingerprints database loaded: ${Object.keys(fingerprintsDb).length} fingerprints`);
        
        // --- NEW: Initialize Audio Detector ---
        initAudioDetector();
    }
} catch (error) {
    console.error('Could not read or parse fingerprints.json.', error);
}

// --- NEW: Audio Detector Functions ---
function initAudioDetector() {
    if (audioDetector) {
        audioDetector.stopListening();
    }
    
    audioDetector = new SimpleAudioDetector(fingerprintsDb, (matchName, confidence, metadata) => {
        console.log(`[AUDIO] Match detected: ${matchName} (${(confidence * 100).toFixed(1)}%)`);
        console.log(`[AUDIO] Energy: ${metadata.energy.toFixed(1)}dB at ${new Date(metadata.detectionTime).toLocaleTimeString()}`);
        
        // Only trigger if we're waiting for a match
        if (gameState === 'WAITING') {
            handleMatchEvent('MATCH_START', {
                matchNumber: currentMatchNumber,
                matchType: currentMatchType,
                isManual: false,
                confidence: confidence,
                triggerType: 'audio',
                audioMetadata: metadata
            });
        } else {
            console.log(`[AUDIO] Ignoring detection - game state is: ${gameState}`);
        }
    });
    
    console.log('[AUDIO] Simple detector initialized with your optimized parameters');
}

// --- Enhanced Recording & Event Functions (Your existing functions) ---
function generateFileName(cameraKey, matchNumber, matchType) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
    const matchTypeConfig = MATCH_TYPES[matchType] || MATCH_TYPES.practice;
    return `${matchTypeConfig.prefix}${matchNumber}_${cameraKey}_${timestamp}.mp4`;
}

function startRecording(cameraKey, matchNumber, matchType) {
    if (recordingProcesses.has(cameraKey)) {
        console.log(`[RECORDING] Recording already active for ${cameraKey}`);
        return;
    }
    
    const camera = cameraConfig[cameraKey];
    if (!camera) return console.error(`[RECORDING] Error: Camera key "${cameraKey}" not found.`);
    
    const streamUrl = `http://${camera.ip}:${camera.port}${camera.path}`;
    const fileName = generateFileName(cameraKey, matchNumber, matchType);
    const outputPath = path.join(RECORDINGS_DIR, fileName);
    
    console.log(`[RECORDING] Starting recording for "${camera.name}" to ${outputPath}`);
    
    const ffmpegArgs = [
        '-y', '-i', streamUrl, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', 
        '-movflags', '+faststart', '-fflags', '+genpts', 
        '-timeout', '10000000', '-reconnect', '1', '-reconnect_streamed', '1',
        outputPath
    ];
    
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { shell: true, stdio: 'pipe' });
    recordingProcesses.set(cameraKey, { 
        process: ffmpegProcess, 
        outputPath, 
        fileName,
        startTime: Date.now(),
        matchNumber,
        matchType
    });

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
            console.log(`[RECORDING] Completed: ${recordingInfo.fileName} (${duration.toFixed(1)}s)`);
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
    
    const recordingFiles = [];
    for (const [cameraKey, recordingInfo] of recordingProcesses.entries()) {
        recordingFiles.push(recordingInfo.fileName);
        try {
            recordingInfo.process.stdin.write('q\n');
        } catch (err) {
            recordingInfo.process.kill('SIGTERM');
        }
    }
    
    if (recordingFiles.length > 0) {
        console.log(`[RECORDING] Stopped recordings: ${recordingFiles.join(', ')}`);
    }
    
    recordingProcesses.clear();
    return recordingFiles;
}

function handleMatchEvent(eventType, payload = {}) {
    const { matchNumber, matchType, isManual } = payload;
    const useMatchNumber = matchNumber || currentMatchNumber;
    const useMatchType = matchType || currentMatchType;
    const matchTypeConfig = MATCH_TYPES[useMatchType];
    
    if (eventType === 'MATCH_START') {
        if (gameState === 'RECORDING') return;
        if (matchStopTimeout) clearTimeout(matchStopTimeout);
        
        console.log(`[EVENT] ${matchTypeConfig.label} ${useMatchNumber} start triggered ${isManual ? '(Manual)' : '(Audio Detection)'}.`);
        gameState = 'RECORDING';
        matchStartTime = Date.now();
        matchEndedBy = 'timer';
        currentMatchNumber = useMatchNumber;
        currentMatchType = useMatchType;
        
        Object.keys(cameraConfig).forEach(cameraKey => {
            startRecording(cameraKey, useMatchNumber, useMatchType);
        });
        
        matchStopTimeout = setTimeout(() => {
            console.log(`[EVENT] ${matchTypeConfig.label} ${useMatchNumber} timer finished. Stopping recordings.`);
            matchEndedBy = 'timer';
            const recordedFiles = stopAllRecordings();
            gameState = 'WAITING';
            matchStopTimeout = null;
            
            console.log(`[EVENT] Match completed. Files recorded: ${recordedFiles ? recordedFiles.join(', ') : 'None'}`);
            saveMatchState();
        }, MATCH_DURATION_MS);

    } else if (eventType === 'MATCH_ABORT') {
        console.log(`[EVENT] ${matchTypeConfig.label} ${useMatchNumber} abort triggered ${isManual ? '(Manual)' : '(System)'}.`);
        gameState = 'WAITING';
        matchEndedBy = isManual ? 'manual' : 'system';
        
        if (matchStopTimeout) clearTimeout(matchStopTimeout);
        matchStopTimeout = null;
        const recordedFiles = stopAllRecordings();
        
        if (matchStartTime) {
            const duration = (Date.now() - matchStartTime) / 1000;
            console.log(`[EVENT] Match recording stopped after ${duration.toFixed(1)}s. Files: ${recordedFiles ? recordedFiles.join(', ') : 'None'}`);
            currentMatchNumber = useMatchNumber;
            currentMatchType = useMatchType;
            saveMatchState();
            matchStartTime = null;
        }
    }
}

function generateFilePreview(matchNumber, matchType) {
    const matchTypeConfig = MATCH_TYPES[matchType] || MATCH_TYPES.practice;
    const files = [];
    
    for (const cameraKey in cameraConfig) {
        const camera = cameraConfig[cameraKey];
        files.push({
            cameraKey,
            cameraName: camera.name,
            fileName: `${matchTypeConfig.prefix}${matchNumber}_${cameraKey}_[timestamp].mp4`,
            estimatedSize: '~500MB'
        });
    }
    
    return {
        files,
        totalFiles: files.length,
        estimatedDuration: '2:35',
        matchLabel: `${matchTypeConfig.label} ${matchNumber}`
    };
}

// --- HTTP Server with Enhanced API (MODIFIED to include audio endpoints) ---
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
                    currentMatchType,
                    gameState,
                    isRecording: gameState === 'RECORDING',
                    matchEndedBy,
                    audioDetectionActive
                }));
            }

            // --- NEW: Audio Detection API Endpoints ---
            if (method === 'POST' && pathname === '/api/audio/start') {
                if (!audioDetector) initAudioDetector();
                
                if (!audioDetectionActive) {
                    audioDetector.startListening();
                    audioDetectionActive = true;
                    console.log('[API] Audio detection started');
                }
                
                return res.writeHead(200).end(JSON.stringify({ 
                    success: true, 
                    active: audioDetectionActive,
                    status: audioDetector.getStatus()
                }));
            }

            if (method === 'POST' && pathname === '/api/audio/stop') {
                if (audioDetector && audioDetectionActive) {
                    audioDetector.stopListening();
                    audioDetectionActive = false;
                    console.log('[API] Audio detection stopped');
                }
                
                return res.writeHead(200).end(JSON.stringify({ 
                    success: true, 
                    active: audioDetectionActive 
                }));
            }

            if (method === 'GET' && pathname === '/api/audio/status') {
                const status = audioDetector ? audioDetector.getStatus() : { 
                    isProcessing: false, 
                    message: 'Detector not initialized' 
                };
                
                return res.writeHead(200).end(JSON.stringify({
                    active: audioDetectionActive,
                    fingerprints: Object.keys(fingerprintsDb).length,
                    ...status
                }));
            }

            if (method === 'POST' && pathname === '/api/audio/test') {
                console.log('[API] Manual audio test triggered');
                
                if (gameState === 'WAITING') {
                    handleMatchEvent('MATCH_START', {
                        matchNumber: currentMatchNumber,
                        matchType: currentMatchType,
                        isManual: true,
                        confidence: 1.0,
                        triggerType: 'manual-test'
                    });
                }
                
                return res.writeHead(200).end(JSON.stringify({ 
                    success: true, 
                    gameState: gameState,
                    message: 'Test trigger sent'
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
                    
                    // --- NEW: Reinitialize audio detector with new fingerprints ---
                    if (audioDetector) {
                        initAudioDetector();
                    }
                    
                    res.writeHead(200).end(JSON.stringify({ success: true, name: name }));
                });
                return;
            }
            
            if (method === 'DELETE' && pathname.startsWith('/api/fingerprints/')) {
                const fingerprintName = decodeURIComponent(pathname.split('/api/fingerprints/')[1]);
                
                if (fingerprintsDb[fingerprintName]) {
                    delete fingerprintsDb[fingerprintName];
                    
                    fs.writeFile(FINGERPRINTS_DB_PATH, JSON.stringify(fingerprintsDb, null, 2), (err) => {
                        if (err) return res.writeHead(500).end(JSON.stringify({ error: 'Could not delete fingerprint' }));
                        console.log(`[FINGERPRINT] Deleted: ${fingerprintName}`);
                        
                        // --- NEW: Reinitialize audio detector after deletion ---
                        if (audioDetector) {
                            initAudioDetector();
                        }
                        
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
    console.log(`Next match will be recorded as: ${MATCH_TYPES[currentMatchType].prefix}${currentMatchNumber}_[camera]_[timestamp].mp4`);
    
    // --- NEW: Audio detection status ---
    if (audioDetector) {
        console.log(`Audio detection ready with ${Object.keys(fingerprintsDb).length} fingerprints`);
        console.log('Optimized for frequency range: 285-3207Hz with 5-second cooldown');
    }
});

// --- Updated Shutdown Function ---
function shutdown() {
    console.log('\nShutdown signal received...');
    
    // --- NEW: Stop audio detection ---
    if (audioDetector && audioDetectionActive) {
        console.log('[SHUTDOWN] Stopping audio detection...');
        audioDetector.stopListening();
    }
    
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