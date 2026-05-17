#!/usr/bin/env python3
"""
DeepSeek TUI — Terminal-native Session Manager (Textual)
=========================================================
Two-pane UI within the terminal: session list | message preview.
Right-click context menu on sessions: delete · pin · rename.

Usage:
  python session_manager.py           # standalone UI
  deepseek-tui                        # integrated via run.js loop

Integration (run.js):
  1. Launch this instead of deepseek-tui directly.
  2. On exit, read ~/.deepseek/.resume_target for the selected session.
  3. If set → `deepseek resume <id>`; if absent → normal exit.
"""

from __future__ import annotations
import sqlite3, uuid, os, sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.css.query import NoMatches
from textual.reactive import reactive
from textual.screen import ModalScreen, Screen
from textual.widgets import (
    Header, Footer, ListView, ListItem, Label,
    Button, Input, RichLog
)

# ── Paths ──────────────────────────────────────────────────────────
DB_PATH = Path.home() / ".deepseek" / "sessions.db"
RESUME_TARGET = Path.home() / ".deepseek" / ".resume_target"
LAST_SESSION = Path.home() / ".deepseek" / ".last_session"

# ── Theme (GitHub Dark) ────────────────────────────────────────────
CSS = """
SessionManager {
    background: #0d1117;
}
#layout { height: 1fr; }

/* Left panel */
#left-panel {
    width: 36; min-width: 26; max-width: 52;
    background: #0d1117;
    border-right: solid #21262d;
    dock: left;
}
#new-btn {
    width: 100%; margin: 0 0 1 0;
    background: #21262d; color: #c9d1d9;
    border: none; min-height: 3;
}
#new-btn:hover { background: #30363d; }
#session-list { height: 1fr; background: #0d1117; }

SessionItem {
    padding: 1 2;
    background: #0d1117; color: #c9d1d9;
}
SessionItem:hover { background: #161b22; }
SessionItem.-active {
    background: #1a2332;
    border-left: solid #58a6ff;
}
SessionItem.pinned {
    border-left: solid #f78166;
}
SessionItem .title {
    color: #c9d1d9;
    text-style: bold;
}
SessionItem .meta {
    color: #484f58;
    text-style: italic;
}

/* Right panel */
#right-panel { height: 1fr; }
#preview-label {
    background: #161b22; color: #8b949e;
    padding: 1 2; height: 3; text-style: bold;
}
#msg-preview { height: 1fr; background: #0d1117; }

/* Message styling */
.msg-user {
    background: #161b22;
    border-left: solid #58a6ff;
    padding: 1 2; margin: 1 0;
    color: #c9d1d9;
}
.msg-assistant {
    background: #0d1117;
    border-left: solid #3fb950;
    padding: 1 2; margin: 1 0;
    color: #c9d1d9;
}

/* Context menu overlay */
#ctx-menu {
    background: #161b22;
    border: solid #30363d;
    width: 24; height: auto;
    padding: 0;
}
.ctx-item {
    padding: 0 2; min-height: 3;
    background: #161b22; color: #c9d1d9;
}
.ctx-item:hover { background: #1f6feb; color: #fff; }
.ctx-item.danger:hover { background: #da3633; color: #fff; }

/* Rename dialog */
RenameDialog {
    align: center middle;
    background: rgba(0,0,0,0.7);
}
#rename-box {
    width: 40; height: auto;
    background: #161b22;
    border: solid #30363d;
    padding: 2;
}
#rename-box Input {
    width: 100%; margin: 1 0;
}
#rename-box Button {
    width: 50%; margin: 1 0;
    background: #21262d; color: #c9d1d9;
}
#rename-box Button:hover { background: #30363d; }
"""


# ══════════════════════════════════════════════════════════════════
# DB helpers
# ══════════════════════════════════════════════════════════════════

def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    return db

def list_sessions() -> List[sqlite3.Row]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM sessions ORDER BY is_pinned DESC, updated_at DESC"
    ).fetchall()
    db.close()
    return rows

def get_messages(session_id: str, limit: int = 50) -> List[sqlite3.Row]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM messages WHERE session_id=? ORDER BY id LIMIT ?",
        (session_id, limit),
    ).fetchall()
    db.close()
    return rows

def create_session(title: str = "New Session") -> str:
    sid = uuid.uuid4().hex[:12]
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db = get_db()
    db.execute(
        "INSERT INTO sessions (id, title, message_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
        (sid, title, ts, ts),
    )
    db.commit()
    db.close()
    return sid

def delete_session(sid: str) -> None:
    db = get_db()
    db.execute("DELETE FROM messages WHERE session_id=?", (sid,))
    db.execute("DELETE FROM sessions WHERE id=?", (sid,))
    db.commit()
    db.close()

def rename_session(sid: str, new_title: str) -> None:
    db = get_db()
    db.execute("UPDATE sessions SET title=? WHERE id=?", (new_title, sid))
    db.commit()
    db.close()

def toggle_pin(sid: str) -> int:
    db = get_db()
    row = db.execute("SELECT is_pinned FROM sessions WHERE id=?", (sid,)).fetchone()
    if not row:
        db.close()
        return 0
    new_val = 0 if row["is_pinned"] else 1
    db.execute("UPDATE sessions SET is_pinned=? WHERE id=?", (new_val, sid))
    db.commit()
    db.close()
    return new_val


# ══════════════════════════════════════════════════════════════════
# Context menu screen
# ══════════════════════════════════════════════════════════════════

class ContextMenu(Screen[Optional[str]]):
    """Floating context menu with actions for a session."""

    def __init__(self, session_id: str, is_pinned: bool, x: int, y: int) -> None:
        super().__init__()
        self._sid = session_id
        self._pinned = is_pinned
        self._x = x
        self._y = y

    def compose(self) -> ComposeResult:
        pin_label = "Unpin" if self._pinned else "Pin"
        with Vertical(id="ctx-menu"):
            yield Button(pin_label, id="ctx-pin", variant="default")
            yield Button("Rename", id="ctx-rename", variant="default")
            yield Button("Delete", id="ctx-delete", variant="error")

    def on_mount(self) -> None:
        self.styles.offset = (self._x, self._y)

    @on(Button.Pressed, "#ctx-pin")
    def on_pin(self) -> None:
        toggle_pin(self._sid)
        self.dismiss("pin")

    @on(Button.Pressed, "#ctx-rename")
    def on_rename(self) -> None:
        self.dismiss("rename")

    @on(Button.Pressed, "#ctx-delete")
    def on_delete(self) -> None:
        delete_session(self._sid)
        self.dismiss("delete")


# ══════════════════════════════════════════════════════════════════
# Rename dialog
# ══════════════════════════════════════════════════════════════════

class RenameDialog(ModalScreen[Optional[str]]):
    """Modal dialog to rename a session."""

    def __init__(self, session_id: str, current_title: str) -> None:
        super().__init__()
        self._sid = session_id
        self._title = current_title

    def compose(self) -> ComposeResult:
        with Vertical(id="rename-box"):
            yield Label("Rename session:")
            yield Input(value=self._title, id="rename-input")
            with Horizontal():
                yield Button("Cancel", variant="default", id="cancel-btn")
                yield Button("Save", variant="primary", id="save-btn")

    def on_mount(self) -> None:
        self.query_one("#rename-input", Input).focus()

    @on(Button.Pressed, "#save-btn")
    def on_save(self) -> None:
        new_title = self.query_one("#rename-input", Input).value.strip()
        if new_title:
            rename_session(self._sid, new_title)
            self.dismiss(new_title)
        else:
            self.dismiss(None)

    @on(Button.Pressed, "#cancel-btn")
    def on_cancel(self) -> None:
        self.dismiss(None)


# ══════════════════════════════════════════════════════════════════
# Session item widget
# ══════════════════════════════════════════════════════════════════

class SessionItem(ListItem):
    """A single session in the list, supports right-click."""

    def __init__(self, session: sqlite3.Row) -> None:
        super().__init__()
        self.sid = session["id"]
        self.title = (session["title"] or f"Session {session['id'][:8]}")[:60]
        self.count = session["message_count"]
        self.pinned = bool(session["is_pinned"])
        self.updated = (session["updated_at"] or "")[:16]

    def compose(self) -> ComposeResult:
        pin_mark = "📌 " if self.pinned else ""
        with Vertical():
            yield Label(f"{pin_mark}{self.title}", classes="title")
            yield Label(f"{self.count} msgs · {self.updated}", classes="meta")

    def on_mouse_down(self, event) -> None:
        """Right-click -> show context menu."""
        if event.button == 3:  # right button
            app = self.app
            if hasattr(app, 'show_context_menu'):
                app.show_context_menu(self.sid, self.pinned, event.screen_x, event.screen_y)


# ══════════════════════════════════════════════════════════════════
# Main App
# ══════════════════════════════════════════════════════════════════

def _clean_title(raw: str) -> str:
    """Extract meaningful short title from raw session title."""
    if not raw:
        return "(untitled)"
    # Skip <turn_meta> - get the next meaningful line
    lines = raw.replace("\r", "").split("\n")
    for line in lines:
        l = line.strip()
        if not l:
            continue
        if l.startswith("<") and l.endswith(">"):
            continue
        if l.startswith("Current local"):
            continue
        if l.startswith("## ") or l.startswith("---"):
            continue
        return l[:60]
    # Last resort: first non-empty line
    for line in lines:
        if line.strip():
            return line.strip()[:60]
    return raw[:60]


class SessionManager(App):
    """Terminal-native session manager for DeepSeek TUI."""

    TITLE = "DeepSeek Session Manager"
    CSS = CSS
    BINDINGS = [
        ("n", "new_session", "New"),
        ("d", "delete_session", "Delete"),
        ("p", "toggle_pin", "Pin"),
        ("enter", "resume_session", "Resume"),
        ("r", "refresh", "Refresh"),
        ("escape", "cancel", "Back"),
        ("q", "quit_app", "Quit"),
    ]

    selected_sid: reactive[Optional[str]] = reactive(None)

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="layout"):
            with Vertical(id="left-panel"):
                yield Button("+ New Session", id="new-btn", variant="default")
                yield ListView(id="session-list")
            with Vertical(id="right-panel"):
                yield Label("Select a session to preview", id="preview-label")
                yield RichLog(id="msg-preview", highlight=True, wrap=True)
        yield Footer()

    def on_mount(self) -> None:
        # Restore last active session if available
        last_sid = None
        if LAST_SESSION.exists():
            try:
                last_sid = LAST_SESSION.read_text(encoding="utf-8").strip()
            except:
                pass
        self.load_sessions(restore_sid=last_sid)

    def load_sessions(self, restore_sid: Optional[str] = None) -> None:
        """Refresh the session list."""
        sessions = list_sessions()
        lv = self.query_one("#session-list", ListView)
        lv.clear()
        for s in sessions:
            lv.append(SessionItem(s))
        if sessions:
            target_idx = 0
            if restore_sid:
                for i, s in enumerate(sessions):
                    if s["id"] == restore_sid:
                        target_idx = i
                        break
            lv.index = target_idx
            self.selected_sid = sessions[target_idx]["id"]
            self.show_preview(self.selected_sid)
        else:
            self.selected_sid = None
            self.query_one("#preview-label", Label).update("  No sessions yet")
            self.query_one("#msg-preview", RichLog).clear()

    def show_preview(self, sid: str) -> None:
        """Load messages for the selected session."""
        label = self.query_one("#preview-label", Label)
        msgs = get_messages(sid)
        preview = self.query_one("#msg-preview", RichLog)
        preview.clear()

        if not msgs:
            db = get_db()
            row = db.execute("SELECT title FROM sessions WHERE id=?", (sid,)).fetchone()
            db.close()
            title = _clean_title(row["title"] if row else sid)
            label.update(f"  {title}")
            preview.write("[italic dim](empty session)")
            return

        # Clean title: skip <turn_meta> prefix, extract meaningful content
        raw_title = next(
            (m["content"] for m in msgs if m["role"] == "user"),
            f"Session {sid[:8]}",
        )
        title = _clean_title(raw_title)[:60]
        label.update(f"  {title}")

        # Extract and display working paths from first user message
        paths_displayed = False
        if msgs and msgs[0]["role"] == "user":
            first_msg = msgs[0]["content"] or ""
            paths = []
            in_paths_section = False
            for line in first_msg.split("\n"):
                ls = line.strip()
                if "Active paths" in ls or "Working Set" in ls:
                    in_paths_section = True
                    continue
                if in_paths_section and ls.startswith("- ") and ("(file)" in ls or "(dir)" in ls):
                    path_desc = ls[2:].strip()
                    paths.append(path_desc)
                elif in_paths_section and not ls:
                    in_paths_section = False
            if paths:
                preview.write("[dim underline]Working paths:[/]")
                for p in paths[:6]:
                    preview.write(f"[dim]  {p}[/]")
                preview.write("")
                paths_displayed = True

        if paths_displayed:
            preview.write("[dim]--- messages ---[/]")

        for m in msgs[:30]:
            role_label = "You" if m["role"] == "user" else "DeepSeek"
            content = (m["content"] or "")[:500]
            preview.write(f"[b]{role_label}[/b]")
            preview.write(content[:200])
            if len(content) > 200:
                preview.write("... (truncated)")
            preview.write("")

    def _write_resume_target(self, sid: str) -> None:
        RESUME_TARGET.write_text(sid.strip(), encoding="utf-8")

    def _clear_resume_target(self) -> None:
        if RESUME_TARGET.exists():
            RESUME_TARGET.unlink()

    # ── Context menu ───────────────────────────────

    def show_context_menu(self, sid: str, pinned: bool, x: int, y: int) -> None:
        def handle_result(action: Optional[str]) -> None:
            if action == "delete":
                self.selected_sid = None
                self.load_sessions()
            elif action == "pin":
                self.load_sessions(restore_sid=sid)
            elif action == "rename":
                self._open_rename(sid)

        self.push_screen(ContextMenu(sid, pinned, x, y), handle_result)

    def _open_rename(self, sid: str) -> None:
        db = get_db()
        row = db.execute("SELECT title FROM sessions WHERE id=?", (sid,)).fetchone()
        db.close()
        current_title = row["title"] if row else ""

        def handle_result(new_title: Optional[str]) -> None:
            if new_title is not None:
                self.load_sessions(restore_sid=sid)

        self.push_screen(RenameDialog(sid, current_title), handle_result)

    # ── Keyboard actions ───────────────────────────

    def action_new_session(self) -> None:
        sid = create_session()
        self._write_resume_target(sid)
        LAST_SESSION.write_text(sid.strip(), encoding="utf-8")
        self.exit(return_code=0)

    def action_delete_session(self) -> None:
        if not self.selected_sid:
            return
        delete_session(self.selected_sid)
        self.selected_sid = None
        self.load_sessions()

    def action_toggle_pin(self) -> None:
        if not self.selected_sid:
            return
        toggle_pin(self.selected_sid)
        self.load_sessions(restore_sid=self.selected_sid)

    def action_resume_session(self) -> None:
        if not self.selected_sid:
            return
        self._write_resume_target(self.selected_sid)
        LAST_SESSION.write_text(self.selected_sid.strip(), encoding="utf-8")
        self.exit(return_code=0)

    def action_refresh(self) -> None:
        self.load_sessions(restore_sid=self.selected_sid)

    def action_cancel(self) -> None:
        pass

    def action_quit_app(self) -> None:
        self._clear_resume_target()
        self.exit(return_code=0)

    # ── Event handlers ─────────────────────────────

    @on(ListView.Selected)
    def on_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, SessionItem):
            self.selected_sid = item.sid
            self.show_preview(item.sid)

    @on(Button.Pressed, "#new-btn")
    def on_new_click(self) -> None:
        self.action_new_session()


# ══════════════════════════════════════════════════════════════════
# Entry point (standalone)
# ══════════════════════════════════════════════════════════════════

def main():
    app = SessionManager()
    exit_code = app.run()
    # run.js handles the actual deepseek launch.
    # Just exit cleanly — .resume_target or .last_session already written.
    sys.exit(exit_code or 0)


if __name__ == "__main__":
    main()
