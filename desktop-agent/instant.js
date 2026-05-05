/**
 * AgentDOM Desktop — Instant Headless Operations
 * Direct programmatic access to macOS/Windows without any UI interaction.
 * No windows activated, no clicks, no visual changes — pure background execution.
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PLATFORM = os.platform();

// ════════════════════════════════════════════════
//  Instant Operations — No UI Needed
// ════════════════════════════════════════════════

const instant = {

  // ── File System ──
  
  readFile(filePath) {
    return fs.readFileSync(path.resolve(filePath), 'utf-8');
  },

  writeFile(filePath, content) {
    fs.writeFileSync(path.resolve(filePath), content, 'utf-8');
    return { written: true, path: path.resolve(filePath), bytes: Buffer.byteLength(content) };
  },

  appendFile(filePath, content) {
    fs.appendFileSync(path.resolve(filePath), content, 'utf-8');
    return { appended: true };
  },

  listDir(dirPath) {
    const resolved = path.resolve(dirPath || '.');
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : null,
    }));
  },

  fileInfo(filePath) {
    const stat = fs.statSync(path.resolve(filePath));
    return { path: path.resolve(filePath), size: stat.size, isDir: stat.isDirectory(), modified: stat.mtime, created: stat.birthtime };
  },

  moveFile(from, to) {
    fs.renameSync(path.resolve(from), path.resolve(to));
    return { moved: true, from, to };
  },

  copyFile(from, to) {
    fs.copyFileSync(path.resolve(from), path.resolve(to));
    return { copied: true, from, to };
  },

  deleteFile(filePath) {
    fs.rmSync(path.resolve(filePath), { recursive: true, force: true });
    return { deleted: true, path: filePath };
  },

  mkdir(dirPath) {
    fs.mkdirSync(path.resolve(dirPath), { recursive: true });
    return { created: true, path: path.resolve(dirPath) };
  },

  search(dirPath, pattern) {
    try {
      const result = execSync(`find "${path.resolve(dirPath)}" -name "${pattern}" -maxdepth 5 2>/dev/null | head -50`, { encoding: 'utf-8' }).trim();
      return result ? result.split('\n') : [];
    } catch { return []; }
  },

  grep(dirPath, text) {
    try {
      return execSync(`grep -rl "${text}" "${path.resolve(dirPath)}" --include="*.{txt,md,js,ts,py,json,html,css}" 2>/dev/null | head -30`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { return []; }
  },

  // ── Shell / Process ──

  exec(command, timeoutMs) {
    const timeout = Math.min(Number(timeoutMs) || 30000, 300000);
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout, maxBuffer: 50 * 1024 * 1024 }).trim();
      return { success: true, output };
    } catch (e) {
      return { success: false, error: e.message, output: e.stdout || '' };
    }
  },

  listProcesses() {
    const raw = execSync('ps aux --sort=-%mem | head -20', { encoding: 'utf-8' }).trim();
    return raw;
  },

  killProcess(name) {
    try {
      execSync(`pkill -f "${name}"`, { encoding: 'utf-8' });
      return { killed: true, process: name };
    } catch {
      return { killed: false, error: 'Process not found' };
    }
  },

  // ── Clipboard ──

  getClipboard() {
    if (PLATFORM === 'darwin') return execSync('pbpaste', { encoding: 'utf-8' });
    if (PLATFORM === 'win32') return execSync('powershell -c "Get-Clipboard"', { encoding: 'utf-8' }).trim();
    return '';
  },

  setClipboard(text) {
    if (PLATFORM === 'darwin') execSync(`echo "${text.replace(/"/g, '\\"')}" | pbcopy`);
    if (PLATFORM === 'win32') execSync(`powershell -c "Set-Clipboard -Value '${text}'"`)
    return { copied: true };
  },

  // ── System Info ──

  systemInfo() {
    return {
      platform: PLATFORM,
      arch: os.arch(),
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
      uptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
      memory: `${Math.round(os.freemem() / 1024 / 1024)}MB free / ${Math.round(os.totalmem() / 1024 / 1024)}MB total`,
      cpus: os.cpus().length + ' cores',
      nodeVersion: process.version,
    };
  },

  batteryInfo() {
    if (PLATFORM === 'darwin') {
      try {
        const raw = execSync('pmset -g batt', { encoding: 'utf-8' }).trim();
        return raw;
      } catch { return 'Unknown'; }
    }
    return 'Not available';
  },

  diskUsage() {
    try {
      return execSync('df -h / | tail -1', { encoding: 'utf-8' }).trim();
    } catch { return 'Unknown'; }
  },

  // ── App Scripting (Headless) ──

  /** Open a URL in default browser — no window focus needed */
  openUrl(url) {
    if (PLATFORM === 'darwin') execSync(`open "${url}"`);
    if (PLATFORM === 'win32') execSync(`start "${url}"`);
    return { opened: url };
  },

  /** Open a file with its default application */
  openFile(filePath) {
    if (PLATFORM === 'darwin') execSync(`open "${path.resolve(filePath)}"`);
    if (PLATFORM === 'win32') execSync(`start "${path.resolve(filePath)}"`);
    return { opened: path.resolve(filePath) };
  },

  /** Reveal a file in Finder/Explorer */
  revealFile(filePath) {
    if (PLATFORM === 'darwin') execSync(`open -R "${path.resolve(filePath)}"`);
    return { revealed: path.resolve(filePath) };
  },

  /** Send a macOS notification */
  notify(title, message) {
    if (PLATFORM === 'darwin') {
      execSync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`);
    }
    return { sent: true, title, message };
  },

  /** Speak text aloud (text-to-speech) */
  speak(text) {
    if (PLATFORM === 'darwin') execSync(`say "${text.replace(/"/g, '\\"')}"`, { timeout: 30000 });
    return { spoken: text };
  },

  /** Set system volume (0-100) */
  setVolume(level) {
    if (PLATFORM === 'darwin') execSync(`osascript -e 'set volume output volume ${level}'`);
    return { volume: level };
  },

  /** Get/set screen brightness (macOS) */
  getBrightness() {
    if (PLATFORM === 'darwin') {
      try {
        return execSync(`osascript -e 'tell application "System Events" to get value of slider 1 of group 1 of group 2 of toolbar 1 of window 1 of process "System Settings"'`, { encoding: 'utf-8' }).trim();
      } catch { return 'Use System Settings'; }
    }
    return 'N/A';
  },

  /** Get current WiFi name */
  getWifi() {
    if (PLATFORM === 'darwin') {
      try {
        return execSync(`/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I | grep -w SSID | awk '{print $2}'`, { encoding: 'utf-8' }).trim();
      } catch { return 'Unknown'; }
    }
    return 'N/A';
  },

  /** Get current date/time */
  getDateTime() {
    return { iso: new Date().toISOString(), local: new Date().toLocaleString(), timestamp: Date.now() };
  },

  // ── Safari Scripting (headless) ──

  safariOpenUrl(url) {
    execSync(`osascript -e 'tell application "Safari" to open location "${url}"'`);
    return { opened: url };
  },

  safariGetUrl() {
    try {
      return execSync(`osascript -e 'tell application "Safari" to get URL of current tab of window 1'`, { encoding: 'utf-8' }).trim();
    } catch { return null; }
  },

  safariGetPageText() {
    try {
      return execSync(`osascript -e 'tell application "Safari" to get source of current tab of window 1'`, { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }).slice(0, 10000);
    } catch { return null; }
  },

  safariRunJs(code) {
    try {
      return execSync(`osascript -e 'tell application "Safari" to do JavaScript "${code.replace(/"/g, '\\"')}" in current tab of window 1'`, { encoding: 'utf-8' }).trim();
    } catch (e) { return { error: e.message }; }
  },

  // ── Notes / Reminders / Calendar (headless) ──

  createNote(title, body) {
    execSync(`osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {name:"${title}", body:"${body.replace(/"/g, '\\"')}"}'`);
    return { created: true, title };
  },

  createReminder(title, dueDate) {
    let script = `tell application "Reminders" to make new reminder with properties {name:"${title}"`;
    if (dueDate) script += `, due date:date "${dueDate}"`;
    script += `}`;
    execSync(`osascript -e '${script}'`);
    return { created: true, title };
  },

  // ── Git (headless) ──

  gitStatus(repoPath) {
    return this.exec(`cd "${path.resolve(repoPath)}" && git status --short`);
  },

  gitLog(repoPath, count = 5) {
    return this.exec(`cd "${path.resolve(repoPath)}" && git log --oneline -${count}`);
  },

  gitDiff(repoPath) {
    return this.exec(`cd "${path.resolve(repoPath)}" && git diff --stat`);
  },
};

module.exports = instant;
