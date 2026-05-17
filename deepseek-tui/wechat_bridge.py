"""
WeChat ↔ DeepSeek TUI Bridge — 双向消息桥接
===========================================
架构：混合方案 (Clipboard + Screenshot/OCR + SendKeys)

工作流:
  微信浮生收到消息 → Ctrl+A → Ctrl+C 复制 → 转发到 TUI 输入框
  TUI 输出完成     → 监听 stdout/终端 → 转发回微信浮生

苏醒守护:
  后台检测微信消息含 "deepseek苏醒" → 自动拉起 TUI

校正注入 (2026-05-17):
  微信消息以 "校正:" 或 "correction:" 开头 → 写入 .correction_input
  → correction_collector.py 拾取 → .pending_correction → run.js 注入
"""

import time, os, sys, re, json, ctypes, threading, datetime, hashlib
from pathlib import Path
from pynput.keyboard import Controller, Key
import pyperclip

# ── 配置 ──
CONTACT_NAME = "浮生"
POLL_INTERVAL = 3.0  # 秒
TUI_POLL_INTERVAL = 1.0
WAKE_KEYWORD = "deepseek苏醒"
DEEPSEEK_HOME = Path.home() / ".deepseek"
LOG_FILE = DEEPSEEK_HOME / "bridge.log"

# ── Windows API 辅助 ──
user32 = ctypes.windll.user32
SW_RESTORE = 9
SW_SHOW = 5

def find_window(class_name=None, title_match=None):
    """Find window handle by class or title pattern"""
    user32.EnumWindows.restype = ctypes.c_bool
    
    result = [None]
    
    def enum_proc(hwnd, lparam):
        buf = ctypes.create_unicode_buffer(512)
        cls_buf = ctypes.create_unicode_buffer(128)
        user32.GetWindowTextW(hwnd, buf, 512)
        user32.GetClassNameW(hwnd, cls_buf, 128)
        title = buf.value
        cls = cls_buf.value
        
        if class_name and cls != class_name:
            return True
        if title_match and title_match not in title:
            return True
        if not title or len(title) > 10:
            return True
        
        result[0] = hwnd
        return False
    
    callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.c_int)
    user32.EnumWindows(callback(enum_proc), 0)
    return result[0]

def restore_window(hwnd):
    user32.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.2)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)

# ── 键盘控制器 ──
kb = Controller()

def send_combo(*keys):
    """Send keyboard combo: send_combo(Key.ctrl, 'v')"""
    for k in keys:
        kb.press(k)
    for k in reversed(keys):
        kb.release(k)

def type_text(text):
    """Type text (ASCII only, for non-Chinese)"""
    for ch in text:
        if ord(ch) < 128:
            kb.type(ch)
        else:
            pyperclip.copy(ch)
            send_combo(Key.ctrl, 'v')
        time.sleep(0.02)

def paste_text(text):
    """Copy text to clipboard and paste via Ctrl+V"""
    pyperclip.copy(text)
    time.sleep(0.1)
    send_combo(Key.ctrl, 'v')
    time.sleep(0.2)

# ── 微信操作 ──
def get_wechat_handle():
    """Find WeChat window handle"""
    return find_window(class_name="Qt51514QWindowIcon")

def focus_chat(contact):
    """Activate 浮生 chat: Ctrl+F → search → Enter"""
    hwnd = get_wechat_handle()
    if not hwnd:
        return False
    restore_window(hwnd)
    
    send_combo(Key.ctrl, 'f')
    time.sleep(0.4)
    
    pyperclip.copy(contact)
    time.sleep(0.1)
    send_combo(Key.ctrl, 'v')
    time.sleep(0.6)
    
    kb.press(Key.enter)
    kb.release(Key.enter)
    time.sleep(0.5)
    return True

def send_to_wechat(message):
    """Send a message to currently focused WeChat chat"""
    paste_text(message)
    kb.press(Key.enter)
    kb.release(Key.enter)
    log(f"→ 微信: {message[:60]}")

def read_chat_via_clipboard():
    """Try to copy all chat content to clipboard and return text"""
    hwnd = get_wechat_handle()
    if not hwnd:
        return None
    restore_window(hwnd)
    time.sleep(0.3)
    
    # Try Ctrl+A then Ctrl+C
    send_combo(Key.ctrl, 'a')
    time.sleep(0.3)
    send_combo(Key.ctrl, 'c')
    time.sleep(0.2)
    
    content = pyperclip.paste()
    if content and len(content) > 2:
        return content
    return None

# ── TUI 操作 ──
def send_to_tui(message):
    """Forward a message to TUI terminal input"""
    # Find TUI terminal window
    hwnd = find_window(title_match="deepseek")
    if not hwnd:
        # Try to find cmd/node deepseek terminal
        import subprocess
        r = subprocess.run('tasklist /fi "IMAGENAME eq node.exe" /v /fo csv /nh', 
                          shell=True, capture_output=True, text=True, timeout=5)
        for line in r.stdout.split('\n'):
            if 'deepseek' in line.lower():
                parts = line.strip().split('","')
                if len(parts) > 6:
                    pid = parts[1].strip('"')
                    # Find window by PID
                    try:
                        import win32gui, win32process
                        def enum_cb(hwnd, pids):
                            _, pid_ = win32process.GetWindowThreadProcessId(hwnd)
                            if str(pid_) == pid:
                                pids.append(hwnd)
                            return True
                        pids = []
                        win32gui.EnumWindows(enum_cb, pids)
                        if pids:
                            hwnd = pids[0]
                            break
                    except:
                        pass
    
    if hwnd:
        restore_window(hwnd)
        paste_text(message)
        time.sleep(0.2)
        kb.press(Key.enter)
        kb.release(Key.enter)
        return True
    return False

def read_tui_output():
    """Read TUI terminal content (placeholder - needs terminal-specific impl)"""
    return None

# ── 日志 ──
def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except:
        pass

# ── 唤醒检测 ──
class WakeGuardian(threading.Thread):
    """Background thread: monitor WeChat for wake keyword"""
    def __init__(self):
        super().__init__(daemon=True)
        self._stop = threading.Event()
    
    def run(self):
        log("[苏醒] 守护线程启动")
        last_check = ""
        while not self._stop.is_set():
            try:
                content = read_chat_via_clipboard()
                if content and content != last_check:
                    last_check = content
                    if WAKE_KEYWORD in content.lower():
                        log(f"[苏醒] 检测到唤醒词，拉起 TUI...")
                        os.system('start deepseek-tui 2>nul')
                        time.sleep(5)
                        send_to_wechat("DeepSeek TUI 已启动，请发送消息")
                time.sleep(5)
            except:
                time.sleep(5)
    
    def stop(self):
        self._stop.set()

# ── 主桥接循环 ──
def main():
    log("=== WeChat ↔ DeepSeek TUI Bridge ===")
    log(f"联系人: {CONTACT_NAME}")
    log(f"唤醒词: {WAKE_KEYWORD}")
    
    # 先聚焦浮生
    if not focus_chat(CONTACT_NAME):
        log("错误: 无法找到微信浮生窗口")
    
    # 启动苏醒守护
    guardian = WakeGuardian()
    guardian.start()
    
    last_chat_hash = ""
    last_tui_snapshot = ""
    chat_history = []
    
    try:
        while True:
            # ── 1. 读取微信新消息 ──
            content = read_chat_via_clipboard()
            if content and len(content) > 5:
                h = hashlib.md5(content.encode()).hexdigest()[:16]
                if h != last_chat_hash:
                    last_chat_hash = h
                    log(f"📱 微信消息更新 ({len(content)} chars)")
                    # Forward to TUI
                    success = send_to_tui(content)
                    log(f"  → TUI: {'OK' if success else 'FAIL'}")
            
            # ── 2. 读取 TUI 输出 ──
            output = read_tui_output()
            if output and output != last_tui_snapshot:
                last_tui_snapshot = output
                if len(output) > 20:
                    log(f"💻 TUI 输出更新 ({len(output)} chars)")
                    if focus_chat(CONTACT_NAME):
                        send_to_wechat(output)
            
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        log("桥接停止")
    finally:
        guardian.stop()

if __name__ == "__main__":
    main()
