# FRC Replay System

Multi-camera live viewer and event recorder with audio detection for FRC matches.

## Features

- **Multi-user support**: Multiple clients can connect, but only the owner can control recording
- **Session management**: Real-time user list with ownership transfer capabilities
- **Audio detection**: Automatic match start detection using FRC horn fingerprints
- **Match configuration**: Support for Practice, Qualifications, Semi-Finals, and Finals
- **Desync detection**: Automatic camera reconnection when audio/video desync is detected
- **Real-time streaming**: Live camera feeds with manual and automatic recording
- **Match state persistence**: Remembers current match number and type between restarts

## Installation

1. Run the installation script:
   ```
   install.bat
   ```
   Or manually install dependencies:
   ```
   npm install ws@8.14.2
   ```

2. Configure your cameras in `config.json`:
   ```json
   {
     "cameras": {
       "camera1": {
         "name": "Main Camera",
         "ip": "192.168.1.100",
         "port": 8081,
         "path": "/live.flv"
       }
     }
   }
   ```

## Usage

1. Start the server:
   ```
   node server.js
   ```

2. Open your browser to `http://localhost:3000`

3. The first person to connect becomes the owner and can:
   - Start/stop matches
   - Change match type and number
   - Control audio detection settings
   - Transfer ownership to other users

4. Additional users can:
   - View live camera feeds
   - See match status and recordings
   - Access the recordings page

## Multi-User Features

### Ownership System
- First user to connect becomes the owner
- Owner has full control over match recording and settings
- Ownership can be transferred to other connected users
- If owner disconnects, ownership automatically transfers to another user

### Session Management
- Real-time user list showing who's connected
- Users can change their display names
- Owner can transfer ownership to any connected user
- Connection status indicators

### Desync Handling
- Automatic detection of audio/video desync issues
- Only attempts reconnection when NOT recording
- Waits for match to end before reconnecting cameras
- 2-second buffer after match ends before reconnection

## Match State Synchronization

The system maintains match state in `match_state.json`:
- Current match number
- Match type (practice, quals, semifinals, finals)
- Last update timestamp

This ensures the correct match number is displayed even after server restarts.

## Audio Detection

The system can automatically detect FRC match start horns:
- Load audio fingerprints via the fingerprinter page
- Optimized for 285-3207Hz frequency range
- 5-second cooldown between detections
- Only triggers on patterns containing "start" in the name

## API Endpoints

- `GET /api/session` - Get/create user session
- `GET /api/match-state` - Get current match state and user info
- `POST /api/desync` - Report audio/video desync
- WebSocket connection for real-time updates

## File Structure

- `server.js` - Main server with WebSocket support
- `index.html` - Multi-user live viewer interface
- `config.json` - Camera configuration
- `match_state.json` - Persistent match state
- `recordings/` - Recorded match files
- `fingerprints.json` - Audio detection patterns

## Troubleshooting

### Headers Already Sent Error
This has been fixed in the current version. Make sure you're using the latest server.js.

### WebSocket Connection Issues
- Ensure port 3000 is not blocked by firewall
- Check that the WebSocket dependency is installed: `npm install ws`

### Camera Connection Problems
- Verify camera IP addresses and ports in config.json
- Check that cameras are streaming FLV format
- Use the reconnect buttons if streams fail

### Match Number Sync Issues
- The system now properly syncs match numbers between server and clients
- Match numbers increment automatically after each match
- State is preserved in match_state.json