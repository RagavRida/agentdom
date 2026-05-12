# AgentDOM Linux Setup Guide

## Phase 3: AT-SPI Bridge for Linux Desktop Automation

AgentDOM now supports Linux desktop automation via AT-SPI (Assistive Technology Service Provider Interface), mirroring the macOS AX bridge capabilities.

## Prerequisites

### Ubuntu 24.04 LTS (Reference Platform)

```bash
# 1. Install Python dependencies
pip install pyatspi2

# 2. Install input tools (Wayland + X11 support)
sudo apt install ydotool xdotool

# 3. Install test application
sudo apt install gnome-text-editor

# 4. Ensure AT-SPI daemon is running
sudo systemctl start at-spi-dbus-bus.service
sudo systemctl enable at-spi-dbus-bus.service  # Auto-start on boot
```

### Other Distributions

- **Fedora/RHEL**: `dnf install python3-pyatspi ydotool xdotool`
- **Arch**: `pacman -S python-pyatspi ydotool xdotool`
- **Debian**: Same as Ubuntu

## Verify Installation

```bash
cd ~/strollr-site/strollr-clone/artifacts/strollr/n/agent-schema

# Run unit tests (no live app required)
npm run test:linux

# Run live demo (requires gnome-text-editor running)
gnome-text-editor &
npm run demo:linux
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentDOM Core                        │
│                  (from-desktop.js)                      │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼─────┐          ┌─────▼──────┐
    │ macOS    │          │  Linux     │
    │ ax-bridge│          │ atspi-bridge│
    └────┬─────┘          └─────┬──────┘
         │                      │
    ┌────▼─────┐          ┌─────▼──────┐
    │ PyObjC   │          │ pyatspi2   │
    │ AXUIElem │          │ AT-SPI DBus│
    └──────────┘          └────────────┘
```

## Input Methods

The bridge automatically selects the best input method:

1. **ydotool** (preferred): Wayland-native, works on modern Ubuntu/Fedora
2. **xdotool** (fallback): X11-only, legacy compatibility
3. **AT-SPI EditableText**: Direct text interface (when available)

Override via environment variable:
```bash
ATSPI_INPUT=xdotool npm run demo:linux
```

## Supported Apps

### Tested
- ✅ GNOME Text Editor (3 intents: open, write, save)

### Planned
- Nautilus (file manager)
- Firefox (web browser)
- GNOME Terminal
- VS Code (Linux build)

## Known Limitations

- **Wayland isolation**: Some apps may require `xhost +local:` for input tools
- **Snap/Flatpak**: Sandboxed apps may have limited AT-SPI access
- **Lazy loading**: Some UI trees load on-demand (handled via retries)

## Troubleshooting

### "AT-SPI2 daemon not running"
```bash
sudo systemctl status at-spi-dbus-bus.service
sudo systemctl start at-spi-dbus-bus.service
```

### "Neither ydotool nor xdotool available"
```bash
sudo apt install ydotool xdotool
# For ydotool on Wayland, may need:
sudo systemctl start ydotoold
```

### "App not running" but app is open
- Check exact app name: `python3 desktop-agent/atspi-bridge.py list_apps`
- Some apps register with different names (e.g., "Text Editor" vs "gnome-text-editor")

### Scan returns empty array
- App may not expose AT-SPI tree (check accessibility settings)
- Try activating/focusing the app window first

## Development

### Add a New Linux App Manifest

1. Create `manifests/<app-name>/AGENTDOM.md`
2. Start with 3 core intents (defer complex workflows)
3. Test with: `node desktop-agent/index.js scanApp "<App Name>"`
4. Document AT-SPI quirks discovered

### Run Bridge Directly

```bash
# List all apps
python3 desktop-agent/atspi-bridge.py list_apps

# Scan an app
python3 desktop-agent/atspi-bridge.py scan "Text Editor"

# Click a button
python3 desktop-agent/atspi-bridge.py click "Text Editor" "New Document"

# Type into field
python3 desktop-agent/atspi-bridge.py type "Text Editor" "text" "Hello World"
```

## Next Steps

- [ ] Test on real Linux hardware (currently developed on macOS)
- [ ] Add 5 more app manifests (Nautilus, Firefox, Terminal, VS Code, Slack)
- [ ] Implement cross-surface intent routing
- [ ] Handle AT-SPI quirks discovered in production
- [ ] Add screenshot capability (via `gnome-screenshot` or `scrot`)

## Contributing

Found an AT-SPI quirk? Add it to `desktop-agent/atspi-bridge.py` docstring:

```python
Known Quirks:
    - GNOME Terminal: Text content in AXValue, not AXTitle
    - Firefox: Lazy-loads tab tree on first access (retry needed)
    - Snap apps: May need `snap connect <app>:accessibility :accessibility`
```
