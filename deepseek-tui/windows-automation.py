#!/usr/bin/env python3
"""windows-automation.py - DeepSeek TUI Windows GUI automation engine.
Uses pywinauto UIA backend for background operation (no focus stealing).

Usage:
  python windows-automation.py list-apps
  python windows-automation.py list-windows --app wechat
  python windows-automation.py click --window Notepad --control Edit
  python windows-automation.py type-text --window Notepad --control Edit --text hello
  python windows-automation.py press-keys --keys "^a"
  python windows-automation.py drag --from 100,200 --to 300,400
  python windows-automation.py get-ui-tree --app wechat --max-depth 3
  python windows-automation.py screenshot --window wechat --output wechat.png
  python windows-automation.py click-coord --x 500 --y 300
"""
import argparse, json, sys, time
from pathlib import Path

try:
    from pywinauto import Desktop
    from pywinauto.keyboard import send_keys
    HAS_PW = True
except ImportError:
    HAS_PW = False

try:
    from PIL import ImageGrab, ImageDraw
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

def ok(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False, default=str))

def err(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(1)

def find_win(desktop, pattern):
    for w in desktop.windows():
        t = w.window_text()
        if t and pattern.lower() in t.lower():
            return w
    return None

def find_child(parent, text):
    if text.lower() in (parent.window_text() or "").lower():
        return parent
    try:
        for c in parent.children():
            r = find_child(c, text)
            if r: return r
    except Exception: pass
    return None

def tree(ctrl, depth, max_d, path="0"):
    if depth > max_d: return None
    info = {"p": path, "name": ctrl.window_text() or "", "cls": ctrl.class_name() or "",
            "aid": ctrl.automation_id() or ""}
    try:
        kids = ctrl.children()
        if kids and depth < max_d:
            info["c"] = []
            for i, k in enumerate(kids):
                ci = tree(k, depth+1, max_d, f"{path}/{i}")
                if ci: info["c"].append(ci)
    except: pass
    return info

# Commands
def cmd_list_apps():
    d = Desktop(backend="uia")
    apps = []
    for w in d.windows():
        t = w.window_text()
        if t and len(t) > 1:
            apps.append({"title": t, "class": w.class_name(), "aid": w.automation_id() or ""})
    return apps

def cmd_list_windows(app):
    d = Desktop(backend="uia"); return [{ "title": w.window_text(), "class": w.class_name(), "handle": w.handle} for w in d.windows() if (w.window_text() or "") and app.lower() in w.window_text().lower()]

def cmd_ui_tree(app, max_d):
    d = Desktop(backend="uia")
    t = find_win(d, app)
    if not t: return {"error": f"not found: {app}"}
    return {"app": app, "title": t.window_text(), "tree": tree(t, 0, max_d)}

def cmd_click(win, ctrl):
    d = Desktop(backend="uia")
    t = find_win(d, win)
    if not t: return {"error": f"not found: {win}"}
    c = find_child(t, ctrl)
    if not c: return {"error": f"control not found: {ctrl}"}
    c.click_input(); return {"clicked": ctrl}

def cmd_click_coord(x, y):
    from pywinauto import mouse; mouse.click(coords=(x, y)); return {"clicked": f"({x},{y})"}

def cmd_type(win, ctrl, text):
    d = Desktop(backend="uia")
    t = find_win(d, win)
    if not t: return {"error": f"not found: {win}"}
    if ctrl:
        c = find_child(t, ctrl)
        if not c: return {"error": f"control not found: {ctrl}"}
        c.type_keys(text, with_spaces=True)
    else:
        t.type_keys(text, with_spaces=True)
    return {"typed": text}

def cmd_keys(keys):
    send_keys(keys); return {"keys": keys}

def cmd_drag(x1, y1, x2, y2):
    from pywinauto import mouse
    mouse.press(coords=(x1, y1)); time.sleep(0.1)
    mouse.move(coords=(x2, y2)); time.sleep(0.1)
    mouse.release(coords=(x2, y2))
    return {"drag": f"({x1},{y1})->({x2},{y2})"}

def cmd_screenshot(win, out):
    if not HAS_PIL: return {"error": "Pillow not installed"}
    out = out or str(Path.home() / "Desktop" / "deepseek_screenshot.png")
    if win:
        d = Desktop(backend="uia"); t = find_win(d, win)
        if not t: return {"error": f"not found: {win}"}
        r = t.rectangle(); img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
    else:
        img = ImageGrab.grab()
    img.save(out)
    return {"screenshot": out, "size": f"{img.width}x{img.height}"}

def main():
    if not HAS_PW: err("pywinauto not installed. Run: pip install pywinauto")
    p = argparse.ArgumentParser()
    s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("list-apps")
    sp = s.add_parser("list-windows"); sp.add_argument("--app", required=True)
    sp = s.add_parser("get-ui-tree"); sp.add_argument("--app", required=True); sp.add_argument("--max-depth", type=int, default=3)
    sp = s.add_parser("click"); sp.add_argument("--window", required=True); sp.add_argument("--control", required=True)
    sp = s.add_parser("click-coord"); sp.add_argument("--x", type=int, required=True); sp.add_argument("--y", type=int, required=True)
    sp = s.add_parser("type-text"); sp.add_argument("--window", required=True); sp.add_argument("--control", default=""); sp.add_argument("--text", required=True)
    sp = s.add_parser("press-keys"); sp.add_argument("--keys", required=True)
    sp = s.add_parser("drag"); sp.add_argument("--from", dest="fr", required=True); sp.add_argument("--to", dest="to", required=True)
    sp = s.add_parser("screenshot"); sp.add_argument("--window", default=None); sp.add_argument("--output", default=None)

    args = p.parse_args()
    try:
        cmd = args.cmd
        if cmd == "list-apps": r = cmd_list_apps()
        elif cmd == "list-windows": r = cmd_list_windows(args.app)
        elif cmd == "get-ui-tree": r = cmd_ui_tree(args.app, args.max_depth)
        elif cmd == "click": r = cmd_click(args.window, args.control)
        elif cmd == "click-coord": r = cmd_click_coord(args.x, args.y)
        elif cmd == "type-text": r = cmd_type(args.window, args.control, args.text)
        elif cmd == "press-keys": r = cmd_keys(args.keys)
        elif cmd == "drag":
            x1, y1 = map(int, args.fr.split(",")); x2, y2 = map(int, args.to.split(","))
            r = cmd_drag(x1, y1, x2, y2)
        elif cmd == "screenshot": r = cmd_screenshot(args.window, args.output)
        else: err(f"unknown command: {cmd}")
        ok(r)
    except Exception as e: err(str(e))

if __name__ == "__main__": main()
