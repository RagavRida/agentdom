#!/usr/bin/env python3
"""
AgentDOM AT-SPI bridge — Linux desktop automation via AT-SPI.

Mirrors ax-bridge.py's interface for Linux. Uses pyatspi2 to scan and control
desktop applications via the AT-SPI accessibility framework.

Subcommands (argv-driven; output is a single JSON document on stdout):
    scan  <app_name>
    click <app_name> <label>           [index]
    type  <app_name> <field_label>     <text> [index]
    list_apps
    is_running <app_name>

Requires: pyatspi2, ydotool (Wayland) or xdotool (X11)

Setup (Ubuntu 24.04 LTS):
    pip install pyatspi2
    sudo apt install ydotool xdotool gnome-text-editor
    sudo systemctl start at-spi-dbus-bus.service

Known Quirks:
    - [Add as discovered on real Linux hardware]
"""

from __future__ import annotations
import json
import os
import subprocess
import sys
import time
from typing import Any

PYATSPI_AVAILABLE = True
try:
    import pyatspi
except ImportError:
    PYATSPI_AVAILABLE = False
    pyatspi = None

INPUT_METHOD = os.getenv('ATSPI_INPUT', 'ydotool')  # ydotool (Wayland) or xdotool (X11)

def _check_atspi_daemon():
    """Verify AT-SPI2 daemon is running, return True or raise clear error."""
    if not PYATSPI_AVAILABLE:
        raise RuntimeError("pyatspi2 not installed. Run: pip install pyatspi2")
    try:
        pyatspi.Registry.getDesktop(0)
        return True
    except Exception as e:
        raise RuntimeError(
            "AT-SPI2 daemon not running. On Ubuntu:\n"
            "  sudo systemctl start at-spi-dbus-bus.service\n"
            f"  Original error: {e}"
        )

def type_text(text: str) -> tuple[bool, str]:
    """Type text using ydotool (Wayland) or xdotool (X11) fallback."""
    # Try ydotool first (Wayland-native)
    try:
        subprocess.run(['ydotool', 'type', text], check=True, timeout=2, stderr=subprocess.DEVNULL)
        return True, 'ydotool'
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        pass
    
    # Fallback to xdotool (X11)
    try:
        subprocess.run(['xdotool', 'type', '--', text], check=True, timeout=2, stderr=subprocess.DEVNULL)
        return True, 'xdotool'
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        pass
    
    return False, 'none'

# Normalize app names (strip whitespace, case-insensitive matching)
def _norm(s: str) -> str:
    return s.strip().lower() if s else ""

def get_role_mappings():
    """Get role mappings - only callable when pyatspi is available."""
    if not PYATSPI_AVAILABLE:
        return {}, set(), set()
    
    ROLE_TO_TYPE = {
        pyatspi.ROLE_PUSH_BUTTON: "button",
        pyatspi.ROLE_TEXT: "text_input",
        pyatspi.ROLE_ENTRY: "text_input",
        pyatspi.ROLE_PASSWORD_TEXT: "text_input",
        pyatspi.ROLE_PARAGRAPH: "text_area",
        pyatspi.ROLE_CHECK_BOX: "checkbox",
        pyatspi.ROLE_RADIO_BUTTON: "radio",
        pyatspi.ROLE_COMBO_BOX: "combo_box",
        pyatspi.ROLE_MENU_ITEM: "menu_item",
        pyatspi.ROLE_MENU: "menu",
        pyatspi.ROLE_LINK: "link",
        pyatspi.ROLE_TAB: "tab",
        pyatspi.ROLE_LABEL: "label",
        pyatspi.ROLE_SLIDER: "slider",
        pyatspi.ROLE_SCROLL_BAR: "scroll_area",
        pyatspi.ROLE_TABLE: "table",
        pyatspi.ROLE_TREE: "tree_view",
        pyatspi.ROLE_SEARCH_BAR: "search_field",
    }
    
    INTERACTIVE_ROLES = {
        pyatspi.ROLE_PUSH_BUTTON, pyatspi.ROLE_TEXT, pyatspi.ROLE_ENTRY,
        pyatspi.ROLE_PASSWORD_TEXT, pyatspi.ROLE_CHECK_BOX, pyatspi.ROLE_RADIO_BUTTON,
        pyatspi.ROLE_COMBO_BOX, pyatspi.ROLE_MENU_ITEM, pyatspi.ROLE_LINK,
        pyatspi.ROLE_TAB, pyatspi.ROLE_SEARCH_BAR, pyatspi.ROLE_SLIDER,
    }
    
    FIELD_ROLES = {
        pyatspi.ROLE_TEXT, pyatspi.ROLE_ENTRY, pyatspi.ROLE_PASSWORD_TEXT,
        pyatspi.ROLE_PARAGRAPH, pyatspi.ROLE_SEARCH_BAR,
    }
    
    return ROLE_TO_TYPE, INTERACTIVE_ROLES, FIELD_ROLES

MAX_DEPTH_DEFAULT = 8
MAX_CHILDREN_PER_NODE = 80
MAX_TOTAL_ELEMENTS = 800
MAX_STRING_LEN = 2000

def truncate(s: Any) -> Any:
    """Cap string length to prevent massive payloads."""
    if not isinstance(s, str):
        return s
    if len(s) <= MAX_STRING_LEN:
        return s
    return s[:MAX_STRING_LEN] + f"... [+{len(s) - MAX_STRING_LEN} more chars]"

def jsonable(v: Any) -> Any:
    """Convert value to JSON-safe type."""
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        return truncate(v)
    try:
        return truncate(str(v))
    except Exception:
        return None

def describe(role: int, label: str, val: Any) -> str:
    """Generate human-readable description for element."""
    if not PYATSPI_AVAILABLE:
        return label
    
    label_l = label.lower() if label else ""
    if role == pyatspi.ROLE_PUSH_BUTTON:
        return "Click to " + (label_l or "perform action")
    if role in (pyatspi.ROLE_TEXT, pyatspi.ROLE_ENTRY, pyatspi.ROLE_SEARCH_BAR):
        return "Type text into: " + label
    if role == pyatspi.ROLE_CHECK_BOX:
        return ("Uncheck " if val else "Check ") + label
    if role == pyatspi.ROLE_MENU_ITEM:
        return "Execute menu action: " + label
    if role == pyatspi.ROLE_LINK:
        return "Navigate to: " + label
    if role == pyatspi.ROLE_COMBO_BOX:
        return "Select from dropdown: " + label
    if role == pyatspi.ROLE_SLIDER:
        return "Adjust slider: " + label
    if role == pyatspi.ROLE_TAB:
        return "Switch to tab: " + label
    return label

def get_actions(acc) -> list[str]:
    """Get available actions for an accessible object."""
    try:
        if not acc:
            return []
        action = acc.queryAction()
        return [action.getName(i) for i in range(action.nActions)]
    except (NotImplementedError, AttributeError):
        return []

def get_text_value(acc) -> str | None:
    """Get text content from text-supporting elements."""
    try:
        text = acc.queryText()
        return text.getText(0, text.characterCount) if text.characterCount > 0 else None
    except (NotImplementedError, AttributeError):
        return None

def walk(acc, depth: int, max_depth: int, parent_path: str, out: list) -> None:
    """Recursively walk AT-SPI tree and collect interactive elements."""
    if depth > max_depth or len(out) >= MAX_TOTAL_ELEMENTS:
        return
    
    ROLE_TO_TYPE, INTERACTIVE_ROLES, FIELD_ROLES = get_role_mappings()
    
    try:
        role = acc.getRole()
        name = acc.name or ""
        desc = acc.description or ""
        label = name or desc
        
        # Get value from text interface or state
        val = None
        if role in FIELD_ROLES:
            val = get_text_value(acc)
        elif role == pyatspi.ROLE_CHECK_BOX:
            state = acc.getState()
            val = state.contains(pyatspi.STATE_CHECKED)
        
        # Get state info
        state_set = acc.getState()
        enabled = state_set.contains(pyatspi.STATE_ENABLED) or state_set.contains(pyatspi.STATE_SENSITIVE)
        focused = state_set.contains(pyatspi.STATE_FOCUSED)
        
        # Collect interactive elements
        if role in INTERACTIVE_ROLES or (role == pyatspi.ROLE_LABEL and label):
            friendly = ROLE_TO_TYPE.get(role, f"role_{role}")
            out.append({
                "type": friendly,
                "label": truncate(label),
                "description": truncate(describe(role, label, val)),
                "value": jsonable(val),
                "enabled": bool(enabled),
                "focused": bool(focused),
                "actions": get_actions(acc),
                "path": truncate(parent_path),
                "position": None,
                "size": None,
            })
        
        # Recurse into children
        role_name = acc.getRoleName() or ""
        next_path = f"{parent_path}/{name or role_name}"
        for i in range(min(acc.childCount, MAX_CHILDREN_PER_NODE)):
            if len(out) >= MAX_TOTAL_ELEMENTS:
                return
            child = acc.getChildAtIndex(i)
            if child:
                walk(child, depth + 1, max_depth, next_path, out)
    
    except Exception:
        # AT-SPI can throw on lazy-loaded or stale elements
        pass

def find_app(app_name: str):
    """Find running application by name."""
    try:
        _check_atspi_daemon()
    except RuntimeError:
        return None
    
    target = _norm(app_name)
    desktop = pyatspi.Registry.getDesktop(0)
    
    for i in range(desktop.childCount):
        app = desktop.getChildAtIndex(i)
        if app and _norm(app.name) == target:
            return app
    return None

def list_running_apps() -> list:
    """List all running applications visible via AT-SPI."""
    try:
        _check_atspi_daemon()
    except RuntimeError as e:
        return []
    
    out = []
    desktop = pyatspi.Registry.getDesktop(0)
    
    for i in range(desktop.childCount):
        app = desktop.getChildAtIndex(i)
        if app and app.name:
            out.append({
                "name": app.name,
                "pid": app.get_process_id() if hasattr(app, 'get_process_id') else None,
                "active": False,  # AT-SPI doesn't expose active state easily
                "hidden": False,
            })
    return out

def scan(app_name: str) -> list | dict:
    """Scan application UI tree and return interactive elements."""
    app = find_app(app_name)
    if not app:
        return {
            "error": "App not running",
            "app": app_name,
            "hint": f"Open {app_name} first or check exact name with list_apps."
        }
    
    out: list = []
    
    # Walk all top-level windows/frames
    for i in range(app.childCount):
        child = app.getChildAtIndex(i)
        if child:
            walk(child, 0, MAX_DEPTH_DEFAULT, f"window[{i}]", out)
    
    return out

def click(app_name: str, label: str, target_idx: int = 1) -> dict:
    """Click element by label."""
    app = find_app(app_name)
    if not app:
        return {"clicked": False, "error": "App not running", "app": app_name}
    
    state = {"matched": 0, "target": None}
    
    def visit(acc, depth: int) -> bool:
        if depth > MAX_DEPTH_DEFAULT or state["target"]:
            return False
        
        try:
            name = acc.name or ""
            if name == label:
                state["matched"] += 1
                if state["matched"] == target_idx:
                    state["target"] = acc
                    return True
            
            for i in range(acc.childCount):
                child = acc.getChildAtIndex(i)
                if child and visit(child, depth + 1):
                    return True
        except Exception:
            pass
        
        return False
    
    # Search through all windows
    for i in range(app.childCount):
        child = app.getChildAtIndex(i)
        if child and visit(child, 0):
            break
    
    if not state["target"]:
        return {
            "clicked": False,
            "matched": state["matched"],
            "index": target_idx,
            "error": f'No element with label "{label}" found in "{app_name}".',
            "hint": "Run scan first to inspect available labels."
        }
    
    # Perform click action
    try:
        actions = get_actions(state["target"])
        for action_name in ["click", "press", "activate"]:
            if action_name in actions:
                action = state["target"].queryAction()
                for i in range(action.nActions):
                    if action.getName(i) == action_name:
                        action.doAction(i)
                        return {
                            "clicked": True,
                            "method": action_name,
                            "matched": state["matched"],
                            "index": target_idx
                        }
    except Exception as e:
        return {
            "clicked": False,
            "error": f"Failed to click: {e}",
            "matched": state["matched"],
            "index": target_idx
        }
    
    return {
        "clicked": False,
        "error": "No clickable action found",
        "matched": state["matched"],
        "index": target_idx
    }

def type_into(app_name: str, field_label: str, text: str, target_idx: int = 1) -> dict:
    """Type text into field by label."""
    app = find_app(app_name)
    if not app:
        return {"typed": False, "error": "App not running", "app": app_name}
    
    _, _, FIELD_ROLES = get_role_mappings()
    state = {"matched": 0, "target": None}
    
    def visit(acc, depth: int):
        if depth > MAX_DEPTH_DEFAULT or state["target"]:
            return
        
        try:
            role = acc.getRole()
            name = acc.name or ""
            
            if role in FIELD_ROLES and (field_label in name or name == field_label):
                state["matched"] += 1
                if state["matched"] == target_idx:
                    state["target"] = acc
                    return
            
            for i in range(acc.childCount):
                child = acc.getChildAtIndex(i)
                if child:
                    visit(child, depth + 1)
        except Exception:
            pass
    
    # Search through all windows
    for i in range(app.childCount):
        child = app.getChildAtIndex(i)
        if child:
            visit(child, 0)
            if state["target"]:
                break
    
    if not state["target"]:
        return {
            "typed": False,
            "matched": state["matched"],
            "index": target_idx,
            "error": f'No text field with label "{field_label}" found in "{app_name}".',
            "hint": "Run scan first to find available fields."
        }
    
    # Set text value
    try:
        # Try EditableText interface first
        editable = state["target"].queryEditableText()
        editable.setTextContents(text)
        return {
            "typed": True,
            "method": "EditableText",
            "field": field_label,
            "matched": state["matched"],
            "index": target_idx
        }
    except (NotImplementedError, AttributeError):
        pass
    
    # Fallback: focus and use ydotool/xdotool
    try:
        action = state["target"].queryAction()
        for i in range(action.nActions):
            if action.getName(i) == "activate":
                action.doAction(i)
                break
        
        time.sleep(0.1)
        success, method = type_text(text)
        if success:
            return {
                "typed": True,
                "method": method,
                "field": field_label,
                "matched": state["matched"],
                "index": target_idx
            }
        else:
            return {
                "typed": False,
                "error": "Neither ydotool nor xdotool available",
                "matched": state["matched"],
                "index": target_idx
            }
    except Exception as e:
        return {
            "typed": False,
            "error": f"Failed to type: {e}",
            "matched": state["matched"],
            "index": target_idx
        }

def main(argv: list[str]) -> None:
    """Entry point matching ax-bridge.py interface."""
    if len(argv) < 2:
        print(json.dumps({"error": "Usage: atspi-bridge.py <verb> ..."}))
        return
    
    verb = argv[1]
    try:
        if verb == "scan":
            if len(argv) < 3:
                print(json.dumps({"error": "scan requires <app_name>"}))
                return
            result = scan(argv[2])
            print(json.dumps(result if result is not None else []))
        
        elif verb == "click":
            if len(argv) < 4:
                print(json.dumps({"error": "click requires <app_name> <label> [index]"}))
                return
            idx = int(argv[4]) if len(argv) >= 5 and argv[4] else 1
            result = click(argv[2], argv[3], idx)
            print(json.dumps(result))
        
        elif verb == "type":
            if len(argv) < 5:
                print(json.dumps({"error": "type requires <app_name> <field_label> <text> [index]"}))
                return
            idx = int(argv[5]) if len(argv) >= 6 and argv[5] else 1
            result = type_into(argv[2], argv[3], argv[4], idx)
            print(json.dumps(result))
        
        elif verb == "list_apps":
            result = list_running_apps()
            print(json.dumps(result if result is not None else []))
        
        elif verb == "is_running":
            if len(argv) < 3:
                print(json.dumps({"error": "is_running requires <app_name>"}))
                return
            app = find_app(argv[2])
            print(json.dumps({"running": app is not None}))
        
        else:
            print(json.dumps({"error": f"Unknown verb: {verb}"}))
    
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))

if __name__ == "__main__":
    main(sys.argv)
