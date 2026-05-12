# GNOME Text Editor — AgentDOM Manifest

**App**: GNOME Text Editor  
**Platform**: Linux (GNOME)  
**Framework**: GTK4  
**Version**: 40+

## Intents

### editor.open
Open or create a text file.

**Parameters**:
- `path` (string, optional): File path to open. If omitted, creates new document.

**Steps**:
1. If path provided: Click "Open" → type path in file chooser → click "Open"
2. If no path: Click "New Document"

---

### editor.write
Write or append text to the current document.

**Parameters**:
- `text` (string, required): Text content to write

**Steps**:
1. Click in text area
2. Type text

---

### editor.save
Save the current document.

**Parameters**:
- `path` (string, optional): Save path. If omitted, saves to current file.

**Steps**:
1. Press Ctrl+S (or click Save button)
2. If new file: type path in save dialog → click "Save"

## UI Elements

### Main Window
- **New Document** (button): Create new empty document
- **Open** (button): Open file chooser
- **Save** (button): Save current document
- **Text area** (text_input): Main editing area

### File Chooser Dialog
- **Location** (text_input): File path entry
- **Open** (button): Confirm file selection
- **Cancel** (button): Dismiss dialog

## Notes

- GNOME Text Editor uses GTK4 accessibility
- Requires AT-SPI enabled (default on GNOME)
- App name in AT-SPI: "Text Editor" or "gnome-text-editor"
- Keyboard shortcuts work via ydotool/xdotool fallback

## Deferred Intents

- `editor.find`: Multi-step search workflow (add after AT-SPI quirks discovered)
- `editor.close`: Window management complexity (add in Phase 4)
