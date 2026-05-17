
"""
飞书截图哨兵 v2.0 — Feishu Screenshot Sentinel
================================================

【设计原则】
  Ctrl+Shift+A → 飞书原生截图（脚本零干预，剪贴板 = 图片）
  Ctrl+Shift+X → AI 截图（脚本自动唤起飞书截图工具，完成后剪贴板 = 文件路径）

【v2.0 优化】
  - 完整类型注解 (type hints)
  - 结构化日志 (logging + 文件轮转)
  - JSON 配置文件 (config.json)
  - Windows Toast 通知
  - 系统托盘图标（可选，需 pystray）
  - 自动故障恢复（卡死检测）
  - 多格式支持 (PNG/JPG)
  - 更好的单实例锁
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pyperclip
from PIL import Image, ImageGrab
from pynput import keyboard
from pynput.keyboard import Key, KeyCode, Controller as KBController

# ─── 可选依赖 ──────────────────────────────────────────────────────────
TRAY_AVAILABLE = False
try:
    import pystray
    from PIL import ImageDraw
    TRAY_AVAILABLE = True
except ImportError:
    pass


# ─── 日志配置 ──────────────────────────────────────────────────────────

def setup_logging(log_file: str, level: str, max_bytes: int, backup_count: int) -> logging.Logger:
    """配置双输出日志：控制台 + 文件轮转"""
    logger = logging.getLogger("FeishuSentinel")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S"
    )

    # 控制台 handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # 文件 handler（轮转）
    try:
        from logging.handlers import RotatingFileHandler
        fh = RotatingFileHandler(
            log_file, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
        )
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except Exception:
        pass

    return logger


# ─── 配置加载 ──────────────────────────────────────────────────────────

DEFAULT_CONFIG: dict[str, Any] = {
    "save_dir": "feishu_uploads",
    "file_prefix": "cap",
    "max_files": 20,
    "timeout_seconds": 20.0,
    "poll_interval_seconds": 0.3,
    "image_format": "PNG",
    "image_quality": 85,
    "notification": True,
    "log_level": "INFO",
    "log_file": "sentinel.log",
    "log_max_bytes": 1048576,
    "log_backup_count": 3,
    "hotkeys": {
        "ai_screenshot": ["ctrl", "shift", "x"],
        "cancel": "esc"
    },
    "tray_icon": True,
    "simulate_delay": 0.35,
}


def load_config(config_path: str) -> dict[str, Any]:
    """加载 JSON 配置，缺失字段用默认值补齐"""
    cfg = DEFAULT_CONFIG.copy()
    try:
        if os.path.isfile(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            for key, val in user_cfg.items():
                if key.startswith("_"):
                    continue
                if isinstance(val, dict) and isinstance(cfg.get(key), dict):
                    cfg[key].update(val)
                else:
                    cfg[key] = val
    except Exception:
        pass
    return cfg


# ─── 工具函数 ──────────────────────────────────────────────────────────

def ensure_dir(p: str) -> None:
    """确保目录存在"""
    os.makedirs(p, exist_ok=True)


def format_path(file_path: str) -> str:
    """返回 Windows 风格绝对路径（反斜杠）"""
    return os.path.abspath(file_path).replace("/", "\\")


def acquire_lock(port: int = 54237) -> socket.socket | None:
    """单实例锁：绑定本地端口"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.listen(1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s
    except OSError:
        s.close()
        return None


def list_image_files(save_dir: str) -> list[str]:
    """列出目录下所有图片文件，按修改时间降序"""
    extensions = {".png", ".jpg", ".jpeg", ".bmp"}
    try:
        names = os.listdir(save_dir)
    except Exception:
        return []
    out: list[tuple[str, float]] = []
    for name in names:
        if not any(name.lower().endswith(ext) for ext in extensions):
            continue
        p = os.path.join(save_dir, name)
        try:
            if os.path.isfile(p):
                out.append((p, os.stat(p).st_mtime))
        except Exception:
            continue
    out.sort(key=lambda x: x[1], reverse=True)
    return [p for (p, _) in out]


def cleanup_old_files(save_dir: str, max_files: int) -> None:
    """清理超出数量限制的旧文件"""
    files = list_image_files(save_dir)
    for fpath in files[max_files:]:
        try:
            os.remove(fpath)
            logging.getLogger("FeishuSentinel").debug("GC: %s", os.path.basename(fpath))
        except Exception:
            pass


def send_windows_notification(title: str, body: str) -> None:
    """发送 Windows Toast 通知"""
    try:
        ps_code = (
            "$t=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];"
            "$x=$t::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
            "$x.GetElementsByTagName('text')[0].AppendChild($x.CreateTextNode('%s'))>$null;"
            "$x.GetElementsByTagName('text')[1].AppendChild($x.CreateTextNode('%s'))>$null;"
            "$n=[Windows.UI.Notifications.ToastNotification]::new($x);"
            "$t::CreateToastNotifier('FeishuSentinel').Show($n)"
        ) % (title, body)
        subprocess.run(
            ["powershell", "-WindowStyle", "Hidden", "-Command", ps_code],
            capture_output=True, timeout=5
        )
    except Exception:
        pass


# ─── 核心类：AI 截图哨兵 ──────────────────────────────────────────────

class PureAISentinel:
    """
    截图哨兵核心类。
    
    Ctrl+Shift+X → 模拟 Ctrl+Shift+A 唤起飞书截图 → 等待用户操作
    → 检测剪贴板新图片 → 保存到文件 → 剪贴板替换为文件路径。
    
    脚本对 A 键零感知，Ctrl+Shift+A 完全由飞书原生处理。
    """

    def __init__(
        self,
        save_dir: str,
        prefix: str = "cap",
        timeout: float = 20.0,
        poll_interval: float = 0.3,
        max_files: int = 20,
        image_format: str = "PNG",
        image_quality: int = 85,
        simulate_delay: float = 0.35,
        notify: bool = True,
    ) -> None:
        self.save_dir = save_dir
        self.prefix = prefix
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.max_files = max_files
        self.image_format = image_format.upper()
        self.image_quality = image_quality
        self.simulate_delay = simulate_delay
        self.notify = notify

        self._busy: bool = False
        self._busy_lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._last_activity: float = time.time()

        self.logger = logging.getLogger("FeishuSentinel")
        ensure_dir(save_dir)

    # ── 公开接口 ──────────────────────────────────────────────────

    def trigger(self) -> None:
        """热键回调"""
        with self._busy_lock:
            if self._busy:
                self.logger.warning("检测到重复触发，取消当前等待")
                self._cancel_event.set()
                return
            self._busy = True
        self._cancel_event.clear()
        self._last_activity = time.time()
        threading.Thread(target=self._run, daemon=True).start()

    def cancel(self) -> None:
        """Esc 取消"""
        with self._busy_lock:
            if not self._busy:
                return
        self._cancel_event.set()
        self.logger.info("截图等待已取消（Esc）")

    def is_busy(self) -> bool:
        with self._busy_lock:
            return self._busy

    def force_reset(self) -> None:
        """强制重置（异常恢复）"""
        self._cancel_event.set()
        with self._busy_lock:
            self._busy = False
        self.logger.info("状态已强制重置")

    # ── 内部流程 ──────────────────────────────────────────────────

    def _get_clipboard_hash(self) -> str | None:
        """剪贴板图片哈希"""
        try:
            img = ImageGrab.grabclipboard()
            if isinstance(img, Image.Image):
                return hashlib.blake2b(img.tobytes(), digest_size=16).hexdigest()
        except Exception:
            pass
        return None

    def _simulate_feishu_hotkey(self) -> None:
        """模拟 Ctrl+Shift+A 唤起飞书截图工具"""
        kb = KBController()

        # 释放残留的修饰键
        for k in (Key.ctrl_l, Key.ctrl_r, Key.shift_l, Key.shift_r):
            try:
                kb.release(k)
            except Exception:
                pass
        try:
            kb.release(KeyCode.from_char('x'))
        except Exception:
            pass

        time.sleep(self.simulate_delay)

        with kb.pressed(Key.ctrl_l):
            with kb.pressed(Key.shift_l):
                kb.tap('a')

    def _save_image(self, img: Image.Image) -> str:
        """保存图片返回路径"""
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        ext = self.image_format.lower()
        filename = f"{self.prefix}_{ts}.{ext}"
        fpath = os.path.join(self.save_dir, filename)

        save_kwargs: dict[str, Any] = {}
        if self.image_format in ("JPEG", "JPG"):
            img = img.convert("RGB")
            save_kwargs["quality"] = self.image_quality

        img.save(fpath, self.image_format, **save_kwargs)
        return fpath

    def _run(self) -> None:
        """截图等待主循环（独立线程）"""
        try:
            old_hash = self._get_clipboard_hash()

            self.logger.info(">>> Ctrl+Shift+X 触发")
            self._simulate_feishu_hotkey()

            self.logger.info(">>> 已模拟 Ctrl+Shift+A — 请框选截图区域")
            self.logger.info("    Esc 取消 / 再次 Ctrl+Shift+X 取消")

            deadline = time.time() + self.timeout

            while time.time() < deadline:
                if self._cancel_event.is_set():
                    self.logger.info(">>> 已取消")
                    return

                curr_hash = self._get_clipboard_hash()
                if curr_hash and curr_hash != old_hash:
                    time.sleep(0.2)
                    img = ImageGrab.grabclipboard()
                    if isinstance(img, Image.Image):
                        self.logger.info(">>> 检测到新截图，保存中...")
                        fpath = self._save_image(img)
                        out_path = format_path(fpath)
                        pyperclip.copy(out_path)
                        filename = os.path.basename(fpath)

                        self.logger.info("-" * 45)
                        self.logger.info("[完成] 路径已写入剪贴板")
                        self.logger.info("文件: %s", filename)
                        self.logger.info("路径: %s", out_path)
                        self.logger.info("尺寸: %dx%d", img.width, img.height)
                        self.logger.info("-" * 45)

                        if self.notify:
                            send_windows_notification(
                                "飞书截图哨兵",
                                "截图已保存: %s (%dx%d)" % (filename, img.width, img.height)
                            )

                        cleanup_old_files(self.save_dir, self.max_files)
                        self._last_activity = time.time()
                        return

                time.sleep(self.poll_interval)

            self.logger.warning(">>> 超时: %ds内未检测到截图", int(self.timeout))

        except Exception:
            self.logger.exception("截图流程异常")
        finally:
            with self._busy_lock:
                self._busy = False


# ─── 系统托盘 ────────────────────────────────────────────────────────

class TrayIcon:
    """系统托盘图标管理器（可选）"""

    def __init__(self, sentinel: PureAISentinel, on_exit: Any) -> None:
        self.sentinel = sentinel
        self.on_exit = on_exit
        self._icon: Any = None

    def _create_image(self) -> Image.Image:
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse((4, 4, 28, 28), fill=(0, 180, 0))
        return img

    def start(self) -> None:
        if not TRAY_AVAILABLE:
            return
        img = self._create_image()
        menu = pystray.Menu(
            pystray.MenuItem(
                "状态: 空闲" if not self.sentinel.is_busy() else "状态: 等待截图...",
                None, enabled=False
            ),
            pystray.MenuItem("打开截图文件夹", lambda: os.startfile(self.sentinel.save_dir)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", lambda: self.stop()),
        )
        self._icon = pystray.Icon("feishu_sentinel", img, "飞书截图哨兵", menu)
        self._icon.run()

    def stop(self) -> None:
        if self._icon:
            self._icon.stop()
        if self.on_exit:
            self.on_exit()


# ─── 主入口 ────────────────────────────────────────────────────────────

def main() -> None:
    """程序主入口"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(script_dir, "config.json")
    cfg = load_config(config_path)

    # 设置日志
    log_file = os.path.join(script_dir, cfg["log_file"])
    logger = setup_logging(
        log_file, cfg["log_level"],
        cfg["log_max_bytes"], cfg["log_backup_count"],
    )

    # 单实例检测
    lock_socket = acquire_lock()
    if lock_socket is None:
        logger.error("检测到旧实例仍在运行！请关闭旧窗口后重试。")
        logger.error("手动终止: taskkill /f /im python.exe")
        time.sleep(5)
        sys.exit(1)

    save_dir = os.path.join(script_dir, cfg["save_dir"])

    sentinel = PureAISentinel(
        save_dir=save_dir,
        prefix=cfg["file_prefix"],
        timeout=cfg["timeout_seconds"],
        poll_interval=cfg["poll_interval_seconds"],
        max_files=cfg["max_files"],
        image_format=cfg["image_format"],
        image_quality=cfg["image_quality"],
        simulate_delay=cfg["simulate_delay"],
        notify=cfg["notification"],
    )

    # 启动横幅
    logger.info("=" * 50)
    logger.info("  飞书截图哨兵 v2.0")
    logger.info("=" * 50)
    logger.info("  Ctrl+Shift+A  飞书原生截图（脚本零干预）")
    logger.info("  Ctrl+Shift+X  AI 截图（自动唤起飞书，剪贴板=路径）")
    logger.info("  Esc           取消等待 / 重置按键状态")
    logger.info("  保存目录: %s", save_dir)
    logger.info("  格式: %s | 保留: %d张 | 超时: %ds",
                cfg["image_format"], cfg["max_files"], cfg["timeout_seconds"])
    logger.info("")

    # 系统托盘（可选）
    tray: TrayIcon | None = None
    stop_event = threading.Event()

    def on_tray_exit() -> None:
        stop_event.set()

    if cfg.get("tray_icon") and TRAY_AVAILABLE:
        tray = TrayIcon(sentinel, on_tray_exit)
        threading.Thread(target=tray.start, daemon=True).start()
        logger.info("系统托盘已启动")
    elif cfg.get("tray_icon") and not TRAY_AVAILABLE:
        logger.info("系统托盘不可用（pystray 未安装）")

    # 热键监听
    pressed: set[str] = set()
    hotkeys_cfg = cfg.get("hotkeys", {})
    ai_keys = hotkeys_cfg.get("ai_screenshot", ["ctrl", "shift", "x"])
    trigger_char = ai_keys[-1].lower() if ai_keys else "x"

    def _is_trigger_key(key: Any) -> bool:
        if getattr(key, 'vk', None) == 0x58:
            return trigger_char == "x"
        c = getattr(key, 'char', None)
        return c in (trigger_char, trigger_char.upper())

    def on_press(key: Any) -> None:
        if key in (Key.ctrl_l, Key.ctrl_r):
            pressed.add('ctrl')
        elif key in (Key.shift_l, Key.shift_r):
            pressed.add('shift')
        elif _is_trigger_key(key):
            pressed.add('x')

        if pressed >= {'ctrl', 'shift', 'x'}:
            pressed.discard('x')
            logger.debug("热键触发")
            sentinel.trigger()

    def on_release(key: Any) -> None:
        if key in (Key.ctrl_l, Key.ctrl_r):
            pressed.discard('ctrl')
        elif key in (Key.shift_l, Key.shift_r):
            pressed.discard('shift')
        elif _is_trigger_key(key):
            pressed.discard('x')
        elif key == Key.esc:
            pressed.clear()
            sentinel.cancel()

    # 信号处理
    def on_stop(sig: int | None = None, frame: Any = None) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, on_stop)
    try:
        signal.signal(signal.SIGTERM, on_stop)
    except AttributeError:
        pass

    # 启动监听
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.daemon = True
    listener.start()

    try:
        while not stop_event.is_set():
            time.sleep(0.5)
            # 卡死检测：busy 状态超过 30s 自动重置
            if sentinel.is_busy() and time.time() - sentinel._last_activity > 30.0:
                logger.warning("检测到状态卡死，自动重置")
                sentinel.force_reset()
    except KeyboardInterrupt:
        pass
    finally:
        listener.stop()
        lock_socket.close()
        if tray:
            tray.stop()
        logger.info("飞书截图哨兵已停止")


if __name__ == "__main__":
    main()
