#!/usr/bin/env python3
"""
AgentDOM — AT-SPI Bridge Helper (Phase 5)

Linux desktop accessibility bridge. Reads a single JSON command from stdin,
emits a single JSON document on stdout, exits 0 on success / non-zero on
unrecoverable error.

Protocol
--------
Input (one line of JSON on stdin):
    {"cmd": "<verb>", "args": { ... }}

Output (one JSON document on stdout):
    success → {"ok": true, "data": { ... }}
    failure → {"ok": false, "error": "...", "hint?": "..."}

Verbs
-----
    list_windows                          → list every accessible top-level window
    get_tree   {"app": "<name>"}          → recursive accessibility tree
    click      {"app": "<name>", "label": "<l>"[, "index": N]}
    type       {"app": "<name>", "field": "<l>", "text": "<t>"[, "index": N]}
    press_key  {"app": "<name>", "key":   "<shortcut>"}
    read       {"app": "<name>", "label": "<l>"[, "index": N]}

Implementation
--------------
Uses gi.repository.Atspi (PyGObject + python3-atspi). Designed to work with:
GNOME, GTK, Electron-on-Linux (Chromium AX tree), Qt (with QT_ACCESSIBILITY=1).

This helper exits with code 2 if gi/Atspi is unavailable so callers can detect
the missing-dep case without parsing stderr.
"""

from __future__ import annotations

import json
import sys
import time

# ---------------------------------------------------------------------------
# Optional imports — degrade gracefully so a `--check` mode still works on
# systems where Atspi/gi is not installed yet.
# ---------------------------------------------------------------------------

_ATSPI_OK = True
_ATSPI_ERR: str | None = None
try:
    import gi  # type: ignore
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # type: ignore
except Exception as e:  # ImportError, ValueError from require_version, etc.
    _ATSPI_OK = False
    _ATSPI_ERR = str(e)
    Atspi = None  # type: ignore


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
# AT-SPI helpers
# ---------------------------------------------------------------------------

def _desktop():
    if not _ATSPI_OK:
        raise RuntimeError(
            f"gi.repository.Atspi unavailable: {_ATSPI_ERR}. "
            "Install python3-atspi / pygobject and AT-SPI2 daemon."
        )
    return Atspi.get_desktop(0)


def _iter_apps():
    desk = _desktop()
    for i in range(desk.get_child_count()):
        try:
            yield desk.get_child_at_index(i)
        except Exception:
            continue


def _find_app(app_name: str):
    if not app_name:
        return None
    target = app_name.strip().lower()
    for app in _iter_apps():
        try:
            name = (app.get_name() or "").strip().lower()
        except Exception:
            continue
        if name == target or target in name:
            return app
    return None


def _accessible_to_json(acc, depth: int = 0, max_depth: int = 12) -> dict:
    try:
        role = acc.get_role_name()
    except Exception:
        role = "unknown"
    try:
        name = acc.get_name() or ""
    except Exception:
        name = ""
    try:
        states = [s.value_nick for s in acc.get_state_set().get_states()]
    except Exception:
        states = []
    bounds = None
    try:
        comp = acc.queryComponent()
        ext = comp.get_extents(Atspi.CoordType.SCREEN)
        bounds = {"x": ext.x, "y": ext.y, "w": ext.width, "h": ext.height}
    except Exception:
        bounds = None

    node = {
        "role":   role,
        "name":   name,
        "states": states,
        "bounds": bounds,
    }

    if depth < max_depth:
        children = []
        try:
            for j in range(acc.get_child_count()):
                try:
                    child = acc.get_child_at_index(j)
                    if child is not None:
                        children.append(_accessible_to_json(child, depth + 1, max_depth))
                except Exception:
                    continue
        except Exception:
            children = []
        if children:
            node["children"] = children
    return node


def _walk_for_label(acc, label: str, matches: list, max_depth: int = 12, depth: int = 0):
    if depth > max_depth:
        return
    try:
        n = acc.get_name() or ""
    except Exception:
        n = ""
    if n == label:
        matches.append(acc)
    try:
        for j in range(acc.get_child_count()):
            try:
                ch = acc.get_child_at_index(j)
                if ch is not None:
                    _walk_for_label(ch, label, matches, max_depth, depth + 1)
            except Exception:
                continue
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Verb handlers
# ---------------------------------------------------------------------------

def cmd_list_windows(_args):
    out = []
    for app in _iter_apps():
        try:
            out.append({
                "app":      app.get_name() or "",
                "role":     app.get_role_name(),
                "children": app.get_child_count(),
            })
        except Exception:
            continue
    _emit_ok(out)


def cmd_get_tree(args):
    name = args.get("app", "")
    app = _find_app(name)
    if not app:
        return _emit_err(f"app not found: {name}",
                        hint="Run list_windows to see attached apps.",
                        app=name)
    _emit_ok(_accessible_to_json(app, max_depth=int(args.get("max_depth", 12))))


def cmd_click(args):
    name  = args.get("app", "")
    label = args.get("label", "")
    index = int(args.get("index", 1))
    app = _find_app(name)
    if not app:
        return _emit_err(f"app not found: {name}", app=name)

    matches: list = []
    _walk_for_label(app, label, matches)
    if not matches:
        return _emit_err(f"no element with label {label!r}",
                        hint="Call get_tree to inspect labels.",
                        matched=0, index=index, clicked=False)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} match(es) for label {label!r}",
                        matched=len(matches), index=index, clicked=False)
    target = matches[index - 1]
    try:
        # Prefer the canonical "click" action when exposed.
        action_iface = target.queryAction()
        for i in range(action_iface.get_n_actions()):
            if (action_iface.get_action_name(i) or "").lower() in {"click", "press", "activate"}:
                action_iface.do_action(i)
                return _emit_ok({"clicked": True, "method": "do_action",
                                 "matched": len(matches), "index": index})
        # Fallback: synthesize a mouse click at center
        comp = target.queryComponent()
        ext = comp.get_extents(Atspi.CoordType.SCREEN)
        cx = ext.x + ext.width // 2
        cy = ext.y + ext.height // 2
        Atspi.generate_mouse_event(cx, cy, "b1c")
        _emit_ok({"clicked": True, "method": "mouse",
                  "matched": len(matches), "index": index,
                  "at": {"x": cx, "y": cy}})
    except Exception as e:
        _emit_err(f"click failed: {e}", matched=len(matches), index=index, clicked=False)


def cmd_type(args):
    name  = args.get("app", "")
    field = args.get("field", "")
    text  = args.get("text", "")
    index = int(args.get("index", 1))
    app = _find_app(name)
    if not app:
        return _emit_err(f"app not found: {name}", app=name)
    matches: list = []
    _walk_for_label(app, field, matches)
    if not matches:
        return _emit_err(f"no field with label {field!r}",
                        matched=0, index=index, typed=False)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} field(s) for label {field!r}",
                        matched=len(matches), index=index, typed=False)
    target = matches[index - 1]
    try:
        et = target.queryEditableText()
        et.set_text_contents(text)
        _emit_ok({"typed": True, "method": "EditableText.set_text_contents",
                  "matched": len(matches), "index": index})
    except Exception as e:
        _emit_err(f"type failed: {e}", matched=len(matches), index=index, typed=False)


def cmd_press_key(args):
    key = args.get("key", "")
    if not key:
        return _emit_err("key required", hint='e.g. {"key": "ctrl+s"}')
    try:
        Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING)
        _emit_ok({"pressed": True, "key": key})
    except Exception as e:
        _emit_err(f"press_key failed: {e}", key=key)


def cmd_read(args):
    name  = args.get("app", "")
    label = args.get("label", "")
    index = int(args.get("index", 1))
    app = _find_app(name)
    if not app:
        return _emit_err(f"app not found: {name}", app=name)
    matches: list = []
    _walk_for_label(app, label, matches)
    if not matches:
        return _emit_err(f"no element with label {label!r}", matched=0, index=index)
    if len(matches) < index:
        return _emit_err(f"only {len(matches)} match(es) for label {label!r}",
                        matched=len(matches), index=index)
    target = matches[index - 1]
    value = None
    try:
        ti = target.queryText()
        value = ti.get_text(0, ti.get_character_count())
    except Exception:
        pass
    if value is None:
        try:
            vi = target.queryValue()
            value = vi.get_current_value()
        except Exception:
            value = ""
    _emit_ok({
        "label":  label,
        "value":  value,
        "role":   target.get_role_name(),
        "index":  index,
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
    # `--check` short-circuits without touching AT-SPI so callers can probe
    # whether the helper is loadable.
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        if _ATSPI_OK:
            _emit_ok({"available": True, "platform": "linux"})
        else:
            _emit_err("Atspi unavailable", hint=_ATSPI_ERR or "install python3-atspi")
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
        _emit_err(f"unknown cmd: {cmd}",
                  hint=f"available: {sorted(VERBS)}")
        sys.exit(1)

    if not _ATSPI_OK:
        _emit_err(f"Atspi unavailable: {_ATSPI_ERR}",
                  hint="install python3-atspi / pygobject")
        sys.exit(2)

    try:
        handler(args)
    except Exception as e:
        _emit_err(f"{cmd} crashed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
