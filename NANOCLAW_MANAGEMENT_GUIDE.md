# NanoClaw Management Guide

This guide covers all essential procedures for managing your NanoClaw installation, including starting, stopping, restarting, and troubleshooting.

## Table of Contents
1. [Starting NanoClaw](#starting-nanoclaw)
2. [Stopping NanoClaw](#stopping-nanoclaw)
3. [Restarting NanoClaw](#restarting-nanoclaw)
4. [Checking Service Status](#checking-service-status)
5. [Viewing Logs](#viewing-logs)
6. [Platform-Specific Management](#platform-specific-management)
7. [Troubleshooting](#troubleshooting)

## Starting NanoClaw

NanoClaw can be started in different ways depending on your platform and setup:

### If Using Service Management (Recommended)
NanoClaw will start automatically after setup. To manually start:

**On macOS (launchd):**
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**On Linux with systemd:**
```bash
# For user-level service (most common)
systemctl --user start nanoclaw

# For system-level service (if installed as root)
sudo systemctl start nanoclaw
```

### Manual Startup
If you need to start NanoClaw manually without service management:

```bash
# Build the project first (if needed)
npm run build

# Start NanoClaw
npm start

# Or for development with hot reload
npm run dev
```

## Stopping NanoClaw

### If Using Service Management
**On macOS (launchd):**
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

**On Linux with systemd:**
```bash
# For user-level service
systemctl --user stop nanoclaw

# For system-level service
sudo systemctl stop nanoclaw
```

### Manual Shutdown
To stop a manually running NanoClaw instance:

1. Find the process:
```bash
ps aux | grep nanoclaw
```

2. Kill the process:
```bash
# Kill by PID (replace XXXX with actual PID)
kill XXXX

# Or kill all nanoclaw processes
pkill -f nanoclaw
```

## Restarting NanoClaw

### If Using Service Management
**On macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**On Linux with systemd:**
```bash
# For user-level service
systemctl --user restart nanoclaw

# For system-level service
sudo systemctl restart nanoclaw
```

### Manual Restart
```bash
# Stop all running instances
pkill -f nanoclaw

# Start again
npm start
```

## Checking Service Status

### macOS (launchd)
```bash
launchctl list | grep nanoclaw
```

### Linux (systemd)
```bash
# For user-level service
systemctl --user status nanoclaw

# For system-level service
sudo systemctl status nanoclaw
```

## Viewing Logs

NanoClaw logs are stored in the `logs/` directory:

**Main logs:**
```bash
# View recent log entries
tail -f logs/nanoclaw.log

# View error logs
tail -f logs/nanoclaw.error.log

# View last 100 lines
tail -100 logs/nanoclaw.log
```

**Setup logs:**
```bash
# View setup logs
tail -f logs/setup.log
```

## Platform-Specific Management

### macOS
NanoClaw uses `launchd` for service management on macOS. The service configuration is stored at:
`~/Library/LaunchAgents/com.nanoclaw.plist`

### Linux
NanoClaw supports multiple service management approaches on Linux:

1. **systemd (recommended)** - Service file is located at:
   - User level: `~/.config/systemd/user/nanoclaw.service`
   - System level: `/etc/systemd/system/nanoclaw.service`

2. **nohup fallback** - If systemd is not available (e.g., in WSL), NanoClaw creates a wrapper script:
   - `./start-nanoclaw.sh` - Start script
   - `./nanoclaw.pid` - Process ID file

### Manual Startup Script (nohup fallback)
If using the nohup fallback method:

```bash
# Start NanoClaw
./start-nanoclaw.sh

# Stop NanoClaw
kill $(cat nanoclaw.pid)
```

## Troubleshooting

### Common Issues

1. **WhatsApp connection conflicts:**
   - Make sure only one instance of NanoClaw is running
   - Kill orphaned processes: `pkill -f nanoclaw`

2. **Service not starting:**
   - Check logs: `tail -f logs/nanoclaw.log`
   - Verify service status: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)
   - Check if required dependencies are installed (Node.js, Docker)

3. **Docker permissions (Linux):**
   - If using user-level systemd and you were recently added to the docker group, you may need to restart your session
   - Test Docker access: `docker info`

### Reinstalling Service
If you need to reinstall the service configuration:

```bash
# Run the setup again
npm run setup
```

Or directly run the service setup:
```bash
npm run setup service
```

### Updating NanoClaw
To update your NanoClaw installation:

```bash
# Pull latest changes
git pull

# Rebuild
npm run build

# Restart service
systemctl --user restart nanoclaw  # Linux
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### Resetting Configuration
If you need to reset your NanoClaw configuration:

1. Stop the service
2. Backup any important data:
   ```bash
   cp -r groups/ groups-backup/
   cp -r data/ data-backup/
   ```
3. Remove configuration files:
   ```bash
   rm -rf groups/*
   rm -rf data/*
   ```
4. Run setup again:
   ```bash
   npm run setup
   ```

## Useful Commands

### Development Commands
```bash
# Build TypeScript
npm run build

# Run with hot reload for development
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test
```

### Maintenance Commands
```bash
# Format code
npm run format

# Check code formatting
npm run format:check
```

### Container Management
```bash
# Rebuild agent container
docker build -t nanoclaw-agent:latest ./container

# Clean up Docker resources
docker system prune
```

This guide should cover all essential operations for managing your NanoClaw installation. For additional help, consult the main README.md file or use the `/debug` command within NanoClaw itself.