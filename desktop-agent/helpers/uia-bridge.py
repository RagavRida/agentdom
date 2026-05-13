#!/usr/bin/env python3
"""
AgentDOM — Windows UIA Bridge Helper (Phase 5)

Windows desktop accessibility bridge. Mirrors atspi-bridge.py's protocol so
the JS dispatcher does not need platform-specific branching.

Protocol
--------
Input (one line of JSON on stdin):
    {"cmd": "<verb>", "args": { ... }}

Output (one JSON document on stdout):
    {"ok": true,  "data": { ... }}            on success
    {"ok": false, "error": "...", ...}        on failure

Verbs (identical to atspi-bridge.py)
------------------------------------
    list_windows
    get_tree   {"app": "<name>"}
    click      {"app": "<name>", "label": "<l>"[, "index": N]}
    type       {"app": "<name>", "field": "<l>", "text": "<t>"[, "index": N]}
    press_key  {"app": "<name>", "key":   "<shortcut>"}
    read       {"app": "<name>", "label": "<l>"[, "index": N]}

Implementation
--------------
Uses the `uiautomation` package (pure-Python wrapper around UI Automation COM).
Supports Win32, WPF, UWP, and Electron-on-Windows. Exits with code 2 when
uiautomation is unavailable so callers can detect missing deps.
"""

from __future__ import annotations

import json
import sys

_UIA_OK = True
_UIA_ERR: str | None = None
try:
    import uiautomation as uia  # type: ignore
except Exception as e:
    _UIA_OK = False
    _UIA_ERR = str(e)
    uia = None  # type: ignore


def _emit_ok(data):
    sys.stdout.write(json.dumps({"ok": True, "data": data}))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _emit_err(msg: str, hint: str | None = None, **extra):
    payload = {"ok": False, "error": msg}
    if hint:
        payload["hint"] = hint
    payload.update(extra)
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# UIA helpers
# ---------------------------------------------------------------------------

def _root():
    if not _UIA_OK:
        raise RuntimeError(f"uiautomation unavailable: {_UIA_ERR}")
    return uia.GetRootControl()


def _find_app_window(app_name: str):
    if not app_name:
        return None
    needle = app_name.strip().lower()
    root = _root()
    # Walk top-level Window controls (FromControl walks children of root)
    for ctrl in root.GetChildren():
        try:
            name = (ctrl.Name or "").strip().lower()
        except Exception:
            continue
        if not name:
            continue
        if name == needle or needle in name:
            return ctrl
    return None


def _walk(ctrl, depth: int = 0, max_depth: int = 12):
    """Recursive UIA tree → JSON dict."""
    try:
        node = {
            "role":   getattr(ctrl, "ControlTypeName", "unknown"),
            "name":   ctrl.Name or "",
            "states": _states_for(ctrl),
            "bounds": _bounds_for(ctrl),
        }
    except Exception:
        return {"role": "unknown", "name": "", "states": [], "bounds": None}

    if depth < max_depth:
        children = []
        try:
            for ch in ctrl.GetChildren():
                children.append(_walk(ch, depth + 1, max_depth))
        except Exception:
            children = []
        if children:
            node["children"] = children
    return node


def _states_for(ctrl) -> list:
    states = []
    try:
        if getattr(ctrl, "IsOffscreen", False): states.append("offscreen")
    except Exception: pass
    try:
        if getattr(ctrl, "IsEnabled", True) is False: states.append("disabled")
    except Exception: pass
    try:
        if getattr(ctrl, "HasKeyboardFocus", False): states.append("focused")
    except Exception: pass
    return states


def _bounds_for(ctrl):
    try:
        r = ctrl.BoundingRectangle
        return {"x": r.left, "y": r.top,
                "w": r.right - r.left, "h": r.bottom - r.top}
    except Exception:
        return None


def _find_by_name(root_ctrl, label: str) -> list:
    """Breadth-first search for every control whose Name == label."""
    found: list = []
    queue = [root_ctrl]
    visited = 0
    while queue and visited < 5000:
        node = queue.pop(0)
        visited += 1
        try:
            if (node.Name or "") == label:
                found.append(node)
        except Exception:
            pass
        try:
            queue.extend(node.GetChildren())
        except Exception:
            pass
    return found


# ---------------------------------------------------------------------------
# Verb handlers
# ---------------------------------------------------------------------------

def cmd_list_windows(_args):
    out = []
    try:
        for ctrl in _root().GetChildren():
            try:
                out.append({
                    "app":  ctrl.Name or "",
                    "role": getattr(ctrl, "ControlTypeName", ""),
                    "pid":  getattr(ctrl, "ProcessId", None),
                })
            except Exception:
                continue
    except Exception as e:
        return _emit_err(f"list_windows failed: {e}")
    _emit_ok(out)


def cmd_get_tree(args):
    app = _find_app_window(args.get("app", ""))
    if not app:
        return _emit_err(f"app not found: {args.get('app','')}", app=args.get("app"))
    _emit_ok(_walk(app, max_depth=int(args.get("max_depth", 12))))


def cmd_click(args):
    app = _find_app_window(args.get("app", ""))
    if not app:
        return _emit_err(f"app not found: {args.get('app','')}", app=args.get("app"))
    label = args.get("label", "")
    index = int(args.get("index", 1))
    matches = _find_by_name(app, label)
    if not matches:
        return _emit_err(f"no element with label {label!r}", matched=0, index=index, clicked=False)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} match(es) for label {label!r}",
                        matched=len(matches), index=index, clicked=False)
    target = matches[index - 1]
    method = None
    try:
        if hasattr(target, "GetInvokePattern") and target.GetInvokePattern() is not None:
            target.GetInvokePattern().Invoke()
            method = "InvokePattern"
        elif hasattr(target, "GetTogglePattern") and target.GetTogglePattern() is not None:
            target.GetTogglePattern().Toggle()
            method = "TogglePattern"
        elif hasattr(target, "GetSelectionItemPattern") and target.GetSelectionItemPattern() is not None:
            target.GetSelectionItemPattern().Select()
            method = "SelectionItemPattern"
        else:
            target.Click()
            method = "Click"
        _emit_ok({"clicked": True, "method": method,
                  "matched": len(matches), "index": index})
    except Exception as e:
        _emit_err(f"click failed: {e}", matched=len(matches), index=index, clicked=False)


def cmd_type(args):
    app = _find_app_window(args.get("app", ""))
    if not app:
        return _emit_err(f"app not found: {args.get('app','')}", app=args.get("app"))
    label = args.get("field", "")
    text  = args.get("text", "")
    index = int(args.get("index", 1))
    matches = _find_by_name(app, label)
    if not matches:
        return _emit_err(f"no field with label {label!r}", matched=0, index=index, typed=False)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} field(s) for {label!r}",
                        matched=len(matches), index=index, typed=False)
    target = matches[index - 1]
    try:
        vp = target.GetValuePattern() if hasattr(target, "GetValuePattern") else None
        if vp:
            vp.SetValue(text)
            _emit_ok({"typed": True, "method": "ValuePattern",
                      "matched": len(matches), "index": index})
            return
        target.SendKeys(text)
        _emit_ok({"typed": True, "method": "SendKeys",
                  "matched": len(matches), "index": index})
    except Exception as e:
        _emit_err(f"type failed: {e}", matched=len(matches), index=index, typed=False)


def cmd_press_key(args):
    key = args.get("key", "")
    if not key:
        return _emit_err("key required", hint='e.g. {"key":"ctrl+s"}')
    try:
        uia.SendKeys(key)
        _emit_ok({"pressed": True, "key": key})
    except Exception as e:
        _emit_err(f"press_key failed: {e}", key=key)


def cmd_read(args):
    app = _find_app_window(args.get("app", ""))
    if not app:
        return _emit_err(f"app not found: {args.get('app','')}", app=args.get("app"))
    label = args.get("label", "")
    index = int(args.get("index", 1))
    matches = _find_by_name(app, label)
    if not matches:
        return _emit_err(f"no element with label {label!r}", matched=0, index=index)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} match(es) for label {label!r}",
                        matched=len(matches), index=index)
    target = matches[index - 1]
    value = ""
    try:
        vp = target.GetValuePattern() if hasattr(target, "GetValuePattern") else None
        if vp:
            value = vp.Value
        else:
            value = target.Name or ""
    except Exception:
        value = target.Name or ""
    _emit_ok({
        "label": label,
        "value": value,
        "role":  getattr(target, "ControlTypeName", ""),
        "index": index,
    })


VERBS = {
    "list_windows": cmd_list_windows,
    "get_tree":     cmd_get_tree,
    "click":        cmd_click,
    "type":         cmd_type,
    "press_key":    cmd_press_key,
    "read":         cmd_read,
}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        if _UIA_OK:
            _emit_ok({"available": True, "platform": "windows"})
        else:
            _emit_err("uiautomation unavailable", hint=_UIA_ERR or "pip install uiautomation")
        return

    raw = sys.stdin.read()
    if not raw.strip():
        _emit_err("empty stdin", hint='Send a single JSON line: {"cmd":"list_windows"}')
        sys.exit(1)

    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as e:
        _emit_err(f"invalid JSON on stdin: {e}")
        sys.exit(1)

    cmd  = msg.get("cmd", "")
    args = msg.get("args", {}) or {}

    handler = VERBS.get(cmd)
    if not handler:
        _emit_err(f"unknown cmd: {cmd}", hint=f"available: {sorted(VERBS)}")
        sys.exit(1)

    if not _UIA_OK:
        _emit_err(f"uiautomation unavailable: {_UIA_ERR}",
                  hint="pip install uiautomation")
        sys.exit(2)

    try:
        handler(args)
    except Exception as e:
        _emit_err(f"{cmd} crashed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
