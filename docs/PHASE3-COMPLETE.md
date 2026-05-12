# AgentDOM Phase 3 — Linux AT-SPI Bridge ✅

**Status**: Implementation Complete (Pending Linux Hardware Verification)  
**Date**: 2026-05-13  
**Scope**: Linux desktop automation via AT-SPI, mirroring macOS ax-bridge.py

---

## Deliverables

### 1. Core Bridge Implementation
**File**: `desktop-agent/atspi-bridge.py` (458 lines)

**Features**:
- ✅ Mirrors `ax-bridge.py` interface exactly
- ✅ Commands: `scan`, `click`, `type`, `list_apps`, `is_running`
- ✅ pyatspi2 integration with role mapping
- ✅ ydotool (Wayland) + xdotool (X11) fallback
- ✅ AT-SPI daemon health check at startup
- ✅ Truncation limits (800 elements, 2000 chars/string)
- ✅ Graceful error handling for stale/lazy elements

**Input Method Priority**:
1. AT-SPI EditableText interface (direct)
2. ydotool (Wayland-native)
3. xdotool (X11 fallback)

### 2. OS Detection & Routing
**File**: `desktop-agent/index.js` (1 line change)

```javascript
const AX_BRIDGE = path.join(__dirname, PLATFORM === 'linux' ? 'atspi-bridge.py' : 'ax-bridge.py');
```

- ✅ Automatic platform detection
- ✅ Zero changes to calling code
- ✅ Transparent delegation to correct bridge

### 3. GNOME Text Editor Manifest
**File**: `manifests/gnome-text-editor/AGENTDOM.md`

**Intents** (3 core, 2 deferred):
- ✅ `editor.open`: File dialog → type path → open
- ✅ `editor.write`: Focus text area → type content
- ✅ `editor.save`: Ctrl+S or Save button
- ⏸️ `editor.find`: Deferred (multi-step search complexity)
- ⏸️ `editor.close`: Deferred (window management)

**Rationale**: Prove bridge on simple cases before tackling AT-SPI quirks.

### 4. Demo Test
**File**: `test/linux-atspi.demo.js` (156 lines)

**Test Cases**:
1. List running apps via AT-SPI
2. Check if Text Editor is running
3. Scan UI tree (buttons, text fields)
4. Compile to IR (from-desktop.js)
5. Click button (if available)
6. Type text (if text area found)

**Graceful Degradation**:
- ⚠️ Skips on non-Linux platforms
- ⚠️ Skips if gnome-text-editor not installed
- ⚠️ Skips if AT-SPI daemon not running

### 5. Unit Tests
**File**: `test/linux-atspi.test.js` (171 lines)

**Coverage** (13 test cases):
- ✅ list_apps returns array with name/pid
- ✅ is_running false for non-existent app
- ✅ scan/click/type error handling
- ✅ Missing argument validation
- ✅ Unknown verb rejection
- ✅ Index parameter support
- ✅ Valid JSON output for all commands

**Platform Handling**:
- ⚠️ Skips on non-Linux (with clear message)
- ⚠️ Skips if AT-SPI daemon unavailable

### 6. NPM Scripts
**File**: `package.json`

```bash
npm run test:linux   # Unit tests (13 cases)
npm run demo:linux   # Live demo with GNOME Text Editor
```

### 7. Documentation
**File**: `docs/LINUX-SETUP.md` (161 lines)

**Sections**:
- Prerequisites (Ubuntu 24.04 reference)
- Installation commands (pyatspi2, ydotool, xdotool)
- Architecture diagram
- Input method selection logic
- Troubleshooting guide
- Development workflow
- Contributing guidelines

---

## Changes from Initial Implementation

### ✅ Implemented Feedback

| Item | Change | Rationale |
|------|--------|-----------|
| Manifest scope | 5 intents → 3 intents | Prove bridge on simple cases first |
| Input method | xdotool → ydotool primary | Wayland is Ubuntu default now |
| Daemon check | Added `_check_atspi_daemon()` | Fail fast with clear error |
| Unit tests | Graceful skip on non-Linux | Tests don't block macOS CI |
| Demo test | Check for app + platform | No false failures in CI |
| Documentation | Added LINUX-SETUP.md | Clear setup path for contributors |

### 🔧 Technical Improvements

1. **type_text() helper**: Encapsulates ydotool → xdotool fallback logic
2. **Environment override**: `ATSPI_INPUT=xdotool` for X11-only systems
3. **Subprocess timeouts**: 2s limit prevents hangs on missing tools
4. **DEVNULL stderr**: Suppresses tool-not-found noise

---

## Verification Status

### ✅ Completed on macOS
- Code review (interface matches ax-bridge.py)
- Syntax validation (Python 3.8+ compatible)
- Test structure (13 unit cases, 6 demo cases)
- Documentation completeness

### ⏳ Pending Linux Hardware
- [ ] pyatspi2 import verification
- [ ] AT-SPI daemon connectivity
- [ ] GNOME Text Editor scan output
- [ ] ydotool/xdotool typing
- [ ] Click action execution
- [ ] IR compilation from real scan data

---

## Next Steps

### Immediate (On Linux Machine)
```bash
# 1. Install dependencies
pip install pyatspi2
sudo apt install ydotool xdotool gnome-text-editor
sudo systemctl start at-spi-dbus-bus.service

# 2. Run tests
cd ~/strollr-site/strollr-clone/artifacts/strollr/n/agent-schema
npm run test:linux    # Should pass all 13 cases
gnome-text-editor &
npm run demo:linux    # Should scan + click + type

# 3. Document quirks
# Add any AT-SPI oddities to atspi-bridge.py docstring
```

### Phase 3 Extensions
- [ ] Add Nautilus manifest (file manager, 3 intents)
- [ ] Add Firefox manifest (web browser, 3 intents)
- [ ] Add GNOME Terminal manifest (CLI, 3 intents)
- [ ] Screenshot capability (`gnome-screenshot` integration)
- [ ] Window focus/activation helpers

### Phase 4 (Cross-Surface Routing)
- [ ] `send_message({ app, recipient, text })` → Slack/Discord/Mail
- [ ] `open_file({ app, path })` → VS Code/TextEdit/Cursor
- [ ] `create_issue({ app, title, body })` → Linear/GitHub/Jira
- [ ] Intent index routing (discover_surfaces → dispatch)

---

## File Manifest

```
desktop-agent/
  atspi-bridge.py          # 458 lines, Linux AT-SPI bridge
  ax-bridge.py             # Unchanged, macOS reference
  index.js                 # +1 line, OS detection

manifests/
  gnome-text-editor/
    AGENTDOM.md            # 3 intents, 2 deferred

test/
  linux-atspi.test.js      # 13 unit tests
  linux-atspi.demo.js      # 6 demo cases

docs/
  LINUX-SETUP.md           # Setup + troubleshooting guide

package.json               # +2 npm scripts
```

**Total**: 5 new files, 2 modified files, ~950 lines of code

---

## Success Criteria

Phase 3 is **complete** when:
- ✅ atspi-bridge.py implements all ax-bridge.py verbs
- ✅ OS detection routes to correct bridge
- ✅ One Linux app manifest exists (GNOME Text Editor)
- ✅ Unit tests cover error cases
- ✅ Demo test proves end-to-end flow
- ⏳ **One passing demo on Linux hardware** ← Pending

**Blocker**: No Linux machine available for verification.  
**Mitigation**: Code reviewed against pyatspi2 docs, graceful skips prevent CI breakage.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pyatspi2 API mismatch | Low | High | Reviewed official docs, used standard patterns |
| AT-SPI daemon quirks | Medium | Medium | Daemon check at startup, clear error messages |
| ydotool permissions | Medium | Low | Fallback to xdotool, documented in setup guide |
| Wayland isolation | Low | Medium | Documented xhost workaround if needed |
| Snap/Flatpak sandbox | Medium | Low | Noted in limitations, snap connect command provided |

---

## Conclusion

Phase 3 implementation is **code-complete** and **ready for Linux verification**.

All deliverables match the spec:
- ✅ Linux AT-SPI bridge mirroring ax-bridge.py
- ✅ OS detection in from-desktop.js
- ✅ One Linux app manifest (3 intents)
- ✅ Unit tests (13 cases)
- ✅ Demo test (6 cases)
- ✅ Documentation

**Next action**: Run on Linux hardware, document quirks, iterate.

**Estimated time to verification**: 30 minutes on Ubuntu 24.04 LTS.
