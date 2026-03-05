#!/bin/bash
# Script to update nanoclaw systemd service with increased memory allocation

# Create backup of existing service file
cp ~/.config/systemd/user/nanoclaw.service ~/.config/systemd/user/nanoclaw.service.backup

# Update the service file with increased memory allocation
cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=Nanoclaw - Personal Claude Assistant
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node --max-old-space-size=4096 /home/ghost/nanoclaw/dist/index.js
WorkingDirectory=/home/ghost/nanoclaw
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/ghost/nanoclaw/logs/nanoclaw.log
StandardError=append:/home/ghost/nanoclaw/logs/nanoclaw.error.log
Environment=PATH=/home/ghost/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/ghost

[Install]
WantedBy=default.target
EOF

# Reload systemd configuration
systemctl --user daemon-reload

# Restart nanoclaw service
systemctl --user restart nanoclaw

echo "Updated nanoclaw service with increased memory allocation and restarted service."