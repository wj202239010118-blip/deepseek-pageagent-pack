/**
 * DeepSeek TUI launcher — with integrated sidecars (Page Agent MCP, Sidebar, Bridge, Correction)
 * watchdog (freeze detection + auto-restart), session manager loop, and auto-mode support.
 *
 * Auto mode: when ~/.deepseek/.mode contains "auto", passes --yolo to the deepseek binary
 * for unattended task execution without approval prompts.
 */

const { spawn, spawnSync, execSync } = require("child_process");
const { constants } = require("os");
const path = require("path");
const fs = require("fs");
const { getBinaryPath } = require("./install");

// ── Logger: write to file instead of stderr to avoid polluting TUI terminal ──
const LOG_PATH = process.platform === "win32"
  ? path.join(process.env.USERPROFILE || "C:\\Users\\86133", ".deepseek", "tui-launcher.log")
  : path.join(process.env.HOME || "/tmp", ".deepseek", "tui-launcher.log");

let _logStream = null;
function _ensureLogStream() {
  if (!_logStream) {
    try {
      const dir = path.dirname(LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
    } catch { _logStream = null; }
  }
  return _logStream;
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  const stream = _ensureLogStream();
  if (stream) {
    stream.write(line + "\n");
  }
}

const pkg = require("../package.json");

// ── Constants ──
const PAGEAGENT_PORT = 38401;
const PAGEAGENT_SCRIPT = process.platform === "win32"
  ? "C:\\Users\\86133\\deepseek-pageagent-pack\\page-agent\\packages\\mcp\\src\\index.js"
  : path.join(process.env.HOME, "deepseek-pageagent-pack", "page-agent", "packages", "mcp", "src", "index.js");

const SESSION_MGR_SCRIPT = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\session_manager.py"
  : path.join(process.env.HOME, ".deepseek", "session_manager.py");
const RESUME_TARGET = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\.resume_target"
  : path.join(process.env.HOME, ".deepseek", ".resume_target");
const FEISHU_SENTINEL_SCRIPT = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\feishu-sentinel\\feishu_screenshot_guard.py"
  : path.join(process.env.HOME, ".deepseek", "feishu-sentinel", "feishu_screenshot_guard.py");
const VOICEBOX_LAUNCHER = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\voicebox\\voicebox_launcher.py"
  : path.join(process.env.HOME, ".deepseek", "voicebox", "voicebox_launcher.py");
const VOICE_INPUT = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\voice_input.py"
  : path.join(process.env.HOME, ".deepseek", "voice_input.py");

const BRIDGE_SCRIPT = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\wechat_bridge.py"
  : path.join(process.env.HOME, ".deepseek", "wechat_bridge.py");

// ── Auto mode ──
const MODE_FILE = process.platform === "win32"
  ? "C:\\Users\\86133\\.deepseek\\.mode"
  : path.join(process.env.HOME, ".deepseek", ".mode");

function getMode() {
  try {
    if (fs.existsSync(MODE_FILE)) {
      return fs.readFileSync(MODE_FILE, "utf-8").trim().toLowerCase();
    }
  } catch {}
  return "normal";
}

const WATCHDOG_CPU_INTERVAL_MS = 120_000;
const CPU_STALL_THRESHOLD_S = 10.0;
const MAX_RESTARTS = 3;

// ── Sidecar registry ──
const sidecars = [];

function registerSidecar(proc, label) {
  sidecars.push({ proc, label });
  proc.on("exit", () => {
    const idx = sidecars.findIndex((s) => s.proc === proc);
    if (idx !== -1) sidecars.splice(idx, 1);
  });
}

function cleanupSidecars() {
  for (const { proc, label } of sidecars) {
    try {
      if (proc.killed) continue;
      if (process.platform === "win32") {
        execSync("taskkill /f /t /pid " + proc.pid + " 2>nul", { timeout: 3000, windowsHide: true });
      } else {
        try { proc.kill("SIGTERM"); } catch {}
      }
    } catch { /* best effort */ }
  }
  sidecars.length = 0;
}

// ── Port check ──
function isPortListening(port) {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, {
      timeout: 3000, encoding: "utf8", windowsHide: true,
    });
    return /LISTENING/i.test(out);
  } catch { return false; }
}

// ── Process alive check ──
function isProcessAlive(pid) {
  if (process.platform !== "win32") {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
  try {
    const out = execSync(`tasklist /fi "PID eq ${pid}" /nh`, {
      timeout: 3000, encoding: "utf8", windowsHide: true,
    });
    return out.includes(String(pid));
  } catch { return false; }
}

// ── CPU time query ──
async function getCpuTimeSec(pid) {
  if (process.platform !== "win32") {
    try {
      const out = execSync(`ps -p ${pid} -o time= 2>/dev/null`, {
        timeout: 3000, encoding: "utf8",
      });
      const parts = out.trim().split(":");
      if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
      }
      return null;
    } catch { return null; }
  }
  try {
    const out = execSync(
      `powershell -NoProfile -Command "& { (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds }"`,
      { timeout: 5000, encoding: "utf8", windowsHide: true }
    );
    const val = parseFloat(out.toString().trim());
    return Number.isFinite(val) ? val : null;
  } catch { return null; }
}

// ── Version flag ──
function isVersionFlag(args = process.argv.slice(2)) {
  return args.includes("--version") || args.includes("-V");
}

function handleVersionFallback(binaryName) {
  if (isVersionFlag()) {
    const binVersion = pkg.deepseekBinaryVersion || pkg.version;
    console.log(`${binaryName} (npm wrapper) v${pkg.version}`);
    console.log(`binary version: v${binVersion}`);
    console.log(`repo: ${pkg.repository?.url || "N/A"}`);
    process.exit(0);
  }
}

function explainSpawnError(err, binaryPath) {
  switch (err.code) {
    case "ENOENT":
      return [
        `[deepseek-tui] Binary not found: ${binaryPath}`,
        "  The downloaded binary may be missing or corrupted.",
        "  Try: npm install -g deepseek-tui@latest",
      ].join("\n");
    case "EACCES":
    case "EPERM":
      return [
        `[deepseek-tui] Permission denied: ${binaryPath}`,
        "  The binary exists but cannot be executed.",
        "  On Windows: check antivirus or Controlled Folder Access.",
        "  On Unix:   chmod +x " + binaryPath,
      ].join("\n");
    default:
      return `[deepseek-tui] Failed to execute binary: ${err.message}\n  Path: ${binaryPath}`;
  }
}

// ──────────────────────────────────────────────────
// Sidecar: Page Agent MCP
// ──────────────────────────────────────────────────
function startPageAgentMCP() {
  if (isPortListening(PAGEAGENT_PORT)) {
    log("[sidecar] Page Agent MCP already running on :" + PAGEAGENT_PORT);
    return;
  }
  if (!fs.existsSync(PAGEAGENT_SCRIPT)) {
    log("[sidecar] Page Agent MCP script not found: " + PAGEAGENT_SCRIPT);
    return;
  }
  const proc = spawn("node", [PAGEAGENT_SCRIPT], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  proc.unref();
  let started = false;
  const timeout = setTimeout(() => {
    if (!started) log("[sidecar] Page Agent MCP start timed out (15s)");
  }, 15_000);

  const onData = (data) => {
    const text = data.toString();
    if (!started && (text.includes("HTTP + WS") || text.includes("Hub connected"))) {
      started = true;
      clearTimeout(timeout);
      log("[sidecar] Page Agent MCP ready on :" + PAGEAGENT_PORT);
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  registerSidecar(proc, "pageagent-mcp");
}

// ──────────────────────────────────────────────────
// Sidecar: WeChat ↔ TUI Bridge
// ──────────────────────────────────────────────────
function startVoicebox() {
  log("[sidecar] Starting voicebox ASR...");
  try {
    const r = spawnSync(pythonCmd, [VOICEBOX_LAUNCHER, "--start"], {
      stdio: "pipe", timeout: 20000, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    log("[sidecar] voicebox ASR " + (r.status === 0 ? "ready" : "failed"));
  } catch (e) {
    log("[sidecar] voicebox ASR error: " + e.message);
  }
}

function startVoiceInput() {
  log("[sidecar] Starting voice input listener...");
  try {
    const proc = spawn(pythonCmd, ["-X", "utf8", VOICE_INPUT], {
      windowsHide: true, stdio: "pipe",
    });
    // Log any output for debugging
    proc.stdout.on("data", (d) => log("[voice-input] " + d.toString().trim()));
    proc.stderr.on("data", (d) => log("[voice-input:err] " + d.toString().trim()));
    proc.on("exit", (code) => log("[sidecar] voice input exited: " + code));
    registerSidecar(proc, "voice-input");
  } catch (e) {
    log("[sidecar] voice input error: " + e.message);
  }
}

function startBridge() {
  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    log("[sidecar] Bridge not found: " + BRIDGE_SCRIPT);
    return;
  }
  const proc = spawn("python", ["-X", "utf8", "-u", BRIDGE_SCRIPT], {
    detached: true, windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, PYTHONUTF8: "1", PYTHONPATH: "C:\\Users\\86133\\AppData\\Roaming\\Python\\Python311\\site-packages" },
  });
  proc.unref();
  registerSidecar(proc, "bridge");
  log("[sidecar] WeChat bridge started");
}

// ──────────────────────────────────────────────────
// Sidecar: Feishu Screenshot Sentinel
// ──────────────────────────────────────────────────
function startFeishuSentinel() {
  if (!fs.existsSync(FEISHU_SENTINEL_SCRIPT)) {
    log("[sidecar] Feishu sentinel not found: " + FEISHU_SENTINEL_SCRIPT);
    return;
  }
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const proc = spawn(pythonCmd, [FEISHU_SENTINEL_SCRIPT], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  proc.unref();
  registerSidecar(proc, "feishu-sentinel");
  log("[sidecar] Feishu sentinel started");
}

// ──────────────────────────────────────────────────
// Sidecar: Sidebar (tkinter GUI)
// ──────────────────────────────────────────────────
function startSidebar() {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "pythonw"]
    : ["python3", "python"];

  let pythonCmd = null;
  for (const cmd of candidates) {
    try {
      execSync(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, {
        timeout: 2000, windowsHide: true,
      });
      pythonCmd = cmd;
      break;
    } catch { /* try next */ }
  }
  if (!pythonCmd) { log("[sidecar] Python not found; sidebar skipped"); return; }
  // Sidebar script reference removed — replaced by session_manager.py
}

// ──────────────────────────────────────────────────
// TUI launcher with watchdog
// ──────────────────────────────────────────────────
function startTuiWithWatchdog(binaryPath, args) {
  return new Promise((resolveExit) => {
    let tuiProc = null;
    let cpuWatchTimeout = null;
    let restartCount = 0;
    let lastCpuTime = null;
    let lastCpuCheck = 0;
    let shuttingDown = false;

    function spawnTui() {
      if (tuiProc) { try { tuiProc.kill(); } catch {} }

      // Auto mode: pass --yolo to deepseek binary
      const mode = getMode();
      const finalArgs = mode === "auto" ? [...args, "--yolo"] : args;
      if (mode === "auto") log("[launcher] Auto mode active, adding --yolo");

      tuiProc = spawn(binaryPath, finalArgs, {
        stdio: "inherit",
        env: { ...process.env, DEEPSEEK_TUI_NPM_WRAPPER: "1", DEEPSEEK_TUI_DISABLE_INSTALL: "1" },
      });

      tuiProc.on("exit", (code, signal) => {
        if (shuttingDown) {
          cleanupSidecars();
          resolveExit({ code, signal });
          return;
        }
        if (restartCount < MAX_RESTARTS && code !== 0 && code !== 130 && code !== null) {
          restartCount++;
          log(`[watchdog] TUI exited (code=${code}), restart ${restartCount}/${MAX_RESTARTS}...`);
          setTimeout(spawnTui, 2000);
          return;
        }
        stopCpuWatch();
        cleanupSidecars();
        resolveExit({ code, signal });
      });

      tuiProc.on("error", (err) => {
        log("[watchdog] TUI spawn error: " + err.message);
        cleanupSidecars();
        resolveExit({ code: 1, signal: null });
      });

      startCpuWatch();
    }

    function startCpuWatch() {
      stopCpuWatch();
      (function loop() {
        if (!tuiProc || !tuiProc.pid) return;
        const now = Date.now();
        getCpuTimeSec(tuiProc.pid).then((cpu) => {
          if (cpu !== null && lastCpuTime !== null) {
            const delta = cpu - lastCpuTime;
            if (delta < CPU_STALL_THRESHOLD_S && lastCpuCheck > 0) {
              const elapsedSec = (now - lastCpuCheck) / 1000;
              if (elapsedSec >= (WATCHDOG_CPU_INTERVAL_MS / 1000) - 5) {
                log(`[watchdog] CPU delta=${delta.toFixed(2)}s in ${elapsedSec.toFixed(0)}s. Process paused (API/user wait). Not killing.`);
              }
            }
          }
          lastCpuTime = cpu;
          lastCpuCheck = now;
          if (!shuttingDown) cpuWatchTimeout = setTimeout(loop, WATCHDOG_CPU_INTERVAL_MS);
        });
      })();
    }

    function stopCpuWatch() {
      if (cpuWatchTimeout) { clearTimeout(cpuWatchTimeout); cpuWatchTimeout = null; }
    }

    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopCpuWatch();
      if (tuiProc) try { tuiProc.kill("SIGTERM"); } catch {}
      cleanupSidecars();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    spawnTui();
  });
}

// ──────────────────────────────────────────────────
// Ensure log stream is flushed on exit
// ──────────────────────────────────────────────────
process.on("exit", () => {
  if (_logStream) {
    try { _logStream.end(); } catch {}
  }
});

// ──────────────────────────────────────────────────
// CLI launcher
// ──────────────────────────────────────────────────
function runCliDirect(binaryPath, args) {
  const mode = getMode();
  const finalArgs = mode === "auto" ? [...args, "--yolo"] : args;
  if (mode === "auto") log("[launcher] Auto mode active, adding --yolo");

  const result = spawnSync(binaryPath, finalArgs, {
    stdio: "inherit",
    env: { ...process.env, DEEPSEEK_TUI_NPM_WRAPPER: "1", DEEPSEEK_TUI_DISABLE_INSTALL: "1" },
  });
  if (result.error) {
    handleVersionFallback("deepseek");
    console.error(explainSpawnError(result.error, binaryPath));
    process.exit(1);
  }
  if (result.signal) {
    const signum = constants.signals[result.signal];
    process.exit(typeof signum === "number" ? 128 + signum : 1);
  }
  process.exit(result.status ?? 0);
}

// ──────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────
async function run(binaryName) {
  handleVersionFallback(binaryName);
  const binaryPath = await getBinaryPath(binaryName);
  const args = process.argv.slice(2);

  // Determine if we should show session manager
  const isBareTui = binaryName === "deepseek-tui";
  const isBareCli = binaryName === "deepseek" && args.length === 0;

  if (isBareTui || isBareCli) {
    const mode = getMode();
    const tuiBinary = path.join(path.dirname(binaryPath), "deepseek-tui.exe");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";

    while (true) {
      console.log("");
      console.log("=== DeepSeek Session Manager ===");
      console.log("");

      // Try running session manager. shell:true ensures PATH resolves correctly.
      let smOk = false;
      try {
        const smResult = spawnSync(pythonCmd, ["-X", "utf8", SESSION_MGR_SCRIPT], {
          stdio: "inherit",
          shell: true,
          env: { ...process.env, PYTHONUTF8: "1" },
        });
        smOk = smResult.status === 0;
      } catch (e) {
        // spawn threw - python likely not found
      }

      if (!smOk) {
        // The session_manager.py runs its own error checking. 
        // If it fails, the user already saw the error message.
        // Cleanup and exit.
        console.error("");
        console.error("Session Manager failed to start.");
        console.error("Make sure Python 3.10+ and Textual are installed:");
        console.error("  pip install textual");
        console.error("Or run TUI directly with: deepseek run");
        console.error("");
        process.exit(1);
      }

      // Read resume target
      let targetId = null;
      try {
        if (fs.existsSync(RESUME_TARGET)) {
          targetId = fs.readFileSync(RESUME_TARGET, "utf-8").trim();
          fs.unlinkSync(RESUME_TARGET);
        }
      } catch { targetId = null; }

      if (!targetId) {
        console.log("Session manager closed.");
        cleanupSidecars();
        process.exit(0);
      }

      // Start sidecars only when actually launching the TUI
      startFeishuSentinel();
      startBridge();
      startVoicebox();
      startVoiceInput();

      // Launch deepseek binary with the chosen session
      const dlArgs = ["resume", targetId];
      if (mode === "auto") {
        dlArgs.push("--yolo");
      }

      console.log("Launching TUI (session " + targetId.slice(0, 10) + "...)");
      try {
        const result = spawnSync(tuiBinary, dlArgs, {
          stdio: "inherit",
          env: { ...process.env, DEEPSEEK_TUI_NPM_WRAPPER: "1" },
        });
        console.log("TUI exited (code=" + (result ? result.status : "?") + "). Back to session manager.");
        console.log("");
      } catch (e) {
        console.error("TUI launch failed:", e.message);
      }
    }
  } else {
    runCliDirect(binaryPath, args);
  }
}

async function runDeepseek() { await run("deepseek"); }
async function runDeepseekTui() { await run("deepseek-tui"); }

module.exports = { run, runDeepseek, runDeepseekTui, _internal: { isVersionFlag } };

if (require.main === module) {
  if ((process.argv[1] || "").includes("tui")) runDeepseekTui();
  else runDeepseek();
}
