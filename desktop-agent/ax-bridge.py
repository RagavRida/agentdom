#!/usr/bin/env python3
"""
AgentDOM AX bridge — direct AXUIElement access via PyObjC.

Replaces System Events (which on macOS 26 fails to enumerate windows of
non-frontmost / SwiftUI apps) with the lower-level Accessibility API.

Subcommands (argv-driven; output is a single JSON document on stdout):
    scan  <app_name>
    click <app_name> <label>           [index]    [scope]
    type  <app_name> <field_label>     <text> [index]

Common roles, label resolution, and action names match the prior
desktop-agent/index.js scanApp shape — drop-in replacement.

Requires: pyobjc-framework-ApplicationServices.
"""

from __future__ import annotations
import json
import sys

import AppKit  # type: ignore
import ApplicationServices as AS  # type: ignore

# ── Role table — kept identical to scanApp() so the IR adapters work unchanged ──
ROLE_TO_TYPE = {
    "AXButton": "button",
    "AXTextField": "text_input",
    "AXTextArea": "text_area",
    "AXCheckBox": "checkbox",
    "AXRadioButton": "radio",
    "AXPopUpButton": "dropdown",
    "AXComboBox": "combo_box",
    "AXSlider": "slider",
    "AXMenuItem": "menu_item",
    "AXLink": "link",
    "AXIncrementor": "stepper",
    "AXTab": "tab",
    "AXStaticText": "label",
    "AXMenuBarItem": "menu",
    "AXSearchField": "search_field",
    "AXImage": "image",
    "AXGroup": "group",
    "AXScrollArea": "scroll_area",
    "AXTable": "table",
    "AXOutline": "tree_view",
}

INTERACTIVE = {
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXComboBox", "AXSlider", "AXMenuItem", "AXLink",
    "AXIncrementor", "AXTab", "AXSearchField",
}

FIELD_ROLES = {"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"}

MAX_DEPTH_DEFAULT = 8
MAX_CHILDREN_PER_NODE = 80


# ── PyObjC wrappers ─────────────────────────────────────────────────────────
def find_pid(app_name: str) -> int | None:
    ws = AppKit.NSWorkspace.sharedWorkspace()
    for a in ws.runningApplications():
        if a.localizedName() == app_name:
            return int(a.processIdentifier())
    return None


def find_running_app(app_name: str):
    ws = AppKit.NSWorkspace.sharedWorkspace()
    for a in ws.runningApplications():
        if a.localizedName() == app_name:
            return a
    return None


def ensure_visible(app_name: str) -> int | None:
    """Unhide + activate the app if it's hidden, so AXWindows is populated.
    Returns the pid, or None if the app isn't running."""
    import time
    a = find_running_app(app_name)
    if a is None:
        return None
    if a.isHidden():
        a.unhide()
        time.sleep(0.25)
    pid = int(a.processIdentifier())
    # Quick check — if windows already populated, no need to activate.
    ax = AS.AXUIElementCreateApplication(pid)
    err, wins = AS.AXUIElementCopyAttributeValue(ax, "AXWindows", None)
    if err == 0 and wins:
        return pid
    # Activate (focus-stealing) and re-check, retrying once if the window
    # tree hasn't fully rendered (SwiftUI can be slow on cold activation).
    a.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
    for delay in (0.4, 0.6):
        time.sleep(delay)
        err, wins = AS.AXUIElementCopyAttributeValue(ax, "AXWindows", None)
        if err == 0 and wins:
            break
    return pid


def ax_attr(el, name):
    err, val = AS.AXUIElementCopyAttributeValue(el, name, None)
    return val if err == 0 else None


def ax_actions(el):
    err, val = AS.AXUIElementCopyActionNames(el, None)
    return list(val) if err == 0 else []


def ax_perform(el, action):
    return AS.AXUIElementPerformAction(el, action)


def ax_set(el, attr, value):
    return AS.AXUIElementSetAttributeValue(el, attr, value)


def jsonable(v):
    """Best-effort conversion of an AX value to a JSON-safe scalar."""
    if v is None or isinstance(v, (str, int, float)) or isinstance(v, bool):
        return v
    try:
        return str(v)[:500]
    except Exception:
        return None


# ── Recursive walk (windows + menubar) ──────────────────────────────────────
def describe(role: str, label: str, val) -> str:
    label_l = label.lower() if label else ""
    if role == "AXButton":
        return "Click to " + (label_l or "perform action")
    if role in ("AXTextField", "AXTextArea", "AXSearchField"):
        return "Type text into: " + label
    if role == "AXCheckBox":
        return ("Uncheck " if val else "Check ") + label
    if role == "AXMenuItem":
        return "Execute menu action: " + label
    if role == "AXLink":
        return "Navigate to: " + label
    if role == "AXPopUpButton":
        return "Select from dropdown: " + label
    if role == "AXSlider":
        return "Adjust slider: " + label
    if role == "AXTab":
        return "Switch to tab: " + label
    return label


def walk(el, depth: int, max_depth: int, parent_path: str, out: list):
    if depth > max_depth:
        return
    role = ax_attr(el, "AXRole") or ""
    title = ax_attr(el, "AXTitle") or ""
    desc = ax_attr(el, "AXDescription") or ""
    label = title or desc
    val = ax_attr(el, "AXValue")
    enabled = ax_attr(el, "AXEnabled")
    focused = ax_attr(el, "AXFocused")

    if role in INTERACTIVE or (role == "AXStaticText" and title):
        friendly = ROLE_TO_TYPE.get(role, role)
        out.append({
            "type": friendly,
            "label": label,
            "description": describe(role, label, val),
            "value": jsonable(val),
            "enabled": bool(enabled) if enabled is not None else True,
            "focused": bool(focused) if focused is not None else False,
            "actions": ax_actions(el),
            "path": parent_path,
            "position": None,
            "size": None,
        })

    kids = ax_attr(el, "AXChildren") or []
    next_path = parent_path + "/" + (title or role)
    for k in list(kids)[:MAX_CHILDREN_PER_NODE]:
        walk(k, depth + 1, max_depth, next_path, out)


def scan(app_name: str) -> list | dict:
    pid = ensure_visible(app_name)
    if pid is None:
        return {"error": "App not running", "app": app_name,
                "hint": f"Open {app_name} first."}
    ax_app = AS.AXUIElementCreateApplication(pid)

    out: list = []
    wins = ax_attr(ax_app, "AXWindows") or []
    for i, w in enumerate(wins):
        walk(w, 0, MAX_DEPTH_DEFAULT, f"window[{i}]", out)

    menubar = ax_attr(ax_app, "AXMenuBar")
    if menubar:
        items = ax_attr(menubar, "AXChildren") or []
        for item in items:
            menu_name = ax_attr(item, "AXTitle") or ""
            if not menu_name:
                continue
            out.append({
                "type": "menu", "label": menu_name,
                "description": f"Open {menu_name} menu",
                "value": None, "enabled": True, "focused": False,
                "actions": ["AXPress"], "path": "menubar",
                "position": None, "size": None,
            })
            sub = ax_attr(item, "AXChildren") or []
            # The menu-bar item wraps an AXMenu; descend one level into it.
            for menu in sub:
                m_items = ax_attr(menu, "AXChildren") or []
                for mi in m_items:
                    m_name = ax_attr(mi, "AXTitle") or ""
                    if not m_name:
                        continue
                    out.append({
                        "type": "menu_item", "label": m_name,
                        "description": f"Execute: {menu_name} > {m_name}",
                        "value": None, "enabled": True, "focused": False,
                        "actions": ["AXPress"], "path": f"menu/{menu_name}",
                        "position": None, "size": None,
                    })
    return out


# ── Click ───────────────────────────────────────────────────────────────────
def click(app_name: str, label: str, target_idx: int = 1) -> dict:
    pid = ensure_visible(app_name)
    if pid is None:
        return {"clicked": False, "error": "App not running", "app": app_name}
    ax_app = AS.AXUIElementCreateApplication(pid)
    state = {"matched": 0}

    def visit(el, depth: int) -> bool:
        if depth > MAX_DEPTH_DEFAULT:
            return False
        role = ax_attr(el, "AXRole") or ""
        title = ax_attr(el, "AXTitle") or ax_attr(el, "AXDescription") or ""
        if title == label:
            state["matched"] += 1
            if state["matched"] == target_idx:
                actions = ax_actions(el)
                for action in ("AXPress", "AXConfirm", "AXPick"):
                    if action in actions:
                        ax_perform(el, action)
                        return True
        kids = ax_attr(el, "AXChildren") or []
        for k in kids:
            if visit(k, depth + 1):
                return True
        return False

    # Walk windows first, then the menubar tree.
    wins = ax_attr(ax_app, "AXWindows") or []
    for w in wins:
        if visit(w, 0):
            return {"clicked": True, "method": "AXPress", "matched": state["matched"], "index": target_idx}
    menubar = ax_attr(ax_app, "AXMenuBar")
    if menubar and visit(menubar, 0):
        return {"clicked": True, "method": "AXPress", "matched": state["matched"], "index": target_idx}

    return {
        "clicked": False, "matched": state["matched"], "index": target_idx,
        "error": f'No element with label "{label}" found in "{app_name}".',
        "hint": "Run scan first to inspect available labels. Disambiguate duplicates as 'Label (n)'.",
    }


# ── Type ────────────────────────────────────────────────────────────────────
def type_into(app_name: str, field_label: str, text: str, target_idx: int = 1) -> dict:
    pid = ensure_visible(app_name)
    if pid is None:
        return {"typed": False, "error": "App not running", "app": app_name}
    ax_app = AS.AXUIElementCreateApplication(pid)

    state = {"matched": 0, "target": None}

    def visit(el, depth: int):
        if depth > MAX_DEPTH_DEFAULT or state["target"] is not None:
            return
        role = ax_attr(el, "AXRole") or ""
        title = ax_attr(el, "AXTitle") or ax_attr(el, "AXDescription") or ""
        if role in FIELD_ROLES and (field_label in title or title == field_label):
            state["matched"] += 1
            if state["matched"] == target_idx:
                state["target"] = el
                return
        kids = ax_attr(el, "AXChildren") or []
        for k in kids:
            visit(k, depth + 1)
            if state["target"] is not None:
                return

    wins = ax_attr(ax_app, "AXWindows") or []
    for w in wins:
        visit(w, 0)
        if state["target"] is not None:
            break

    if state["target"] is None:
        return {
            "typed": False, "matched": state["matched"], "index": target_idx,
            "error": f'No text field with label "{field_label}" found in "{app_name}".',
            "hint": "Run scan first to find available fields.",
        }

    # Focus and set value. Failure to focus is non-fatal.
    ax_set(state["target"], "AXFocused", True)
    err = ax_set(state["target"], "AXValue", text)
    if err == 0:
        return {"typed": True, "method": "AXSetValue", "field": field_label,
                "matched": state["matched"], "index": target_idx}
    return {
        "typed": False, "matched": state["matched"], "index": target_idx,
        "error": f"AXSetValue failed (err {err}). Field may be read-only.",
    }


# ── Entry point ─────────────────────────────────────────────────────────────
def main(argv: list[str]) -> None:
    if len(argv) < 2:
        print(json.dumps({"error": "Usage: ax-bridge.py <verb> ..."}))
        return

    verb = argv[1]
    try:
        if verb == "scan":
            if len(argv) < 3:
                print(json.dumps({"error": "scan requires <app_name>"})); return
            print(json.dumps(scan(argv[2])))
        elif verb == "click":
            if len(argv) < 4:
                print(json.dumps({"error": "click requires <app_name> <label> [index]"})); return
            idx = int(argv[4]) if len(argv) >= 5 and argv[4] else 1
            print(json.dumps(click(argv[2], argv[3], idx)))
        elif verb == "type":
            if len(argv) < 5:
                print(json.dumps({"error": "type requires <app_name> <field_label> <text> [index]"})); return
            idx = int(argv[5]) if len(argv) >= 6 and argv[5] else 1
            print(json.dumps(type_into(argv[2], argv[3], argv[4], idx)))
        else:
            print(json.dumps({"error": f"Unknown verb: {verb}"}))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main(sys.argv)
