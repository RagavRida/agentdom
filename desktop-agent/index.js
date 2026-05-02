#!/usr/bin/env node
/**
 * AgentDOM Desktop Agent — Full macOS/Windows native app automation
 * Scan, click, type, navigate menus, take screenshots on ANY native app.
 */

const { execSync, exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLATFORM = os.platform(); // 'darwin' | 'win32' | 'linux'

// ════════════════════════════════════════════════
//  macOS — AppleScript / JXA Accessibility Bridge
// ════════════════════════════════════════════════

const mac = {
  /** List all running apps with windows */
  listApps() {
    const script = `
      const se = Application("System Events");
      const procs = se.processes.whose({ backgroundOnly: false });
      const result = [];
      for (let i = 0; i < procs.length; i++) {
        try {
          const p = procs[i];
          const wins = p.windows.length;
          result.push({ name: p.name(), wins, frontmost: p.frontmost() });
        } catch(e) {}
      }
      JSON.stringify(result);
    `;
    return JSON.parse(execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8' }).trim());
  },

  /** Bring app to front (only when explicitly needed) */
  activate(appName) {
    execSync(`osascript -e 'tell application "${appName}" to activate'`);
    execSync('sleep 0.3');
  },

  /** Silent background focus — sets frontmost without visual activation */
  _silentFocus(appName) {
    try {
      execSync(`osascript -l JavaScript -e 'Application("System Events").processes.byName("${appName}").frontmost = true'`, { timeout: 3000 });
    } catch {}
  },

  /** Scan an app's UI tree — returns agent-readable structured elements. NO activation needed. */
  scanApp(appName) {
    // No activate — reads accessibility tree in background
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${appName}");
      const elements = [];
      const roleNames = {
        AXButton: 'button', AXTextField: 'text_input', AXTextArea: 'text_area',
        AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXPopUpButton: 'dropdown',
        AXComboBox: 'combo_box', AXSlider: 'slider', AXMenuItem: 'menu_item',
        AXLink: 'link', AXIncrementor: 'stepper', AXTab: 'tab',
        AXStaticText: 'label', AXMenuBarItem: 'menu', AXSearchField: 'search_field',
        AXImage: 'image', AXGroup: 'group', AXScrollArea: 'scroll_area',
        AXTable: 'table', AXOutline: 'tree_view'
      };
      
      function scanElement(el, depth, parentPath) {
        if (depth > 4) return;
        try {
          const role = el.role();
          const title = el.title() || '';
          const desc = el.description() || '';
          const subrole = ''; try { subrole = el.subrole() || ''; } catch(e) {}
          let val = null; try { val = el.value(); } catch(e) {}
          let enabled = true; try { enabled = el.enabled(); } catch(e) {}
          let focused = false; try { focused = el.focused(); } catch(e) {}
          let pos = null, size = null;
          try { pos = el.position(); size = el.size(); } catch(e) {}
          
          // Get available actions
          let acts = [];
          try {
            const actions = el.actions();
            for (let a = 0; a < actions.length; a++) {
              acts.push(actions[a].name());
            }
          } catch(e) {}
          
          const interactive = ['AXButton','AXTextField','AXTextArea','AXCheckBox',
            'AXRadioButton','AXPopUpButton','AXComboBox','AXSlider',
            'AXMenuItem','AXLink','AXIncrementor','AXTab','AXSearchField'].includes(role);
          
          if (interactive || (role === 'AXStaticText' && title)) {
            const friendlyRole = roleNames[role] || role;
            const label = title || desc || '';
            // Generate agent-readable description
            let agentDesc = '';
            if (role === 'AXButton') agentDesc = 'Click to ' + (label.toLowerCase() || 'perform action');
            else if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXSearchField') agentDesc = 'Type text into: ' + label;
            else if (role === 'AXCheckBox') agentDesc = (val ? 'Uncheck' : 'Check') + ' ' + label;
            else if (role === 'AXMenuItem') agentDesc = 'Execute menu action: ' + label;
            else if (role === 'AXLink') agentDesc = 'Navigate to: ' + label;
            else if (role === 'AXPopUpButton') agentDesc = 'Select from dropdown: ' + label;
            else if (role === 'AXSlider') agentDesc = 'Adjust slider: ' + label;
            else if (role === 'AXTab') agentDesc = 'Switch to tab: ' + label;
            else agentDesc = label;

            elements.push({
              type: friendlyRole,
              label: label,
              description: agentDesc,
              value: val,
              enabled: enabled,
              focused: focused,
              actions: acts,
              path: parentPath,
              position: pos,
              size: size
            });
          }
          
          try {
            const children = el.uiElements();
            for (let i = 0; i < Math.min(children.length, 50); i++) {
              scanElement(children[i], depth + 1, parentPath + '/' + (title || role));
            }
          } catch(e) {}
        } catch(e) {}
      }
      
      // Scan all windows — NO activation
      const windows = proc.windows();
      for (let w = 0; w < windows.length; w++) {
        scanElement(windows[w], 0, 'window[' + w + ']');
      }
      
      // Scan menu bar
      try {
        const menuBar = proc.menuBars[0];
        const menus = menuBar.menuBarItems();
        for (let m = 0; m < menus.length; m++) {
          const menuName = menus[m].title();
          elements.push({ type: 'menu', label: menuName, description: 'Open ' + menuName + ' menu', value: null, enabled: true, focused: false, actions: ['AXPress'], path: 'menubar', position: null, size: null });
          try {
            const items = menus[m].menus[0].menuItems();
            for (let i = 0; i < items.length; i++) {
              const itemName = items[i].title();
              let shortcut = '';
              try { shortcut = items[i].value() || ''; } catch(e) {}
              if (itemName) {
                elements.push({ type: 'menu_item', label: itemName, description: 'Execute: ' + menuName + ' > ' + itemName, value: shortcut || null, enabled: true, focused: false, actions: ['AXPress'], path: 'menu/' + menuName, position: null, size: null });
              }
            }
          } catch(e) {}
        }
      } catch(e) {}
      
      JSON.stringify(elements);
    `;
    try {
      const raw = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8', timeout: 15000
      }).trim();
      return JSON.parse(raw);
    } catch (e) {
      return { error: e.message, hint: 'Grant Accessibility permission: System Settings > Privacy > Accessibility' };
    }
  },

  /** Click a UI element by label — uses AXPress action, NO activation/foregrounding */
  clickElement(appName, label) {
    // No activate — directly perform AXPress through accessibility API
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${appName}");
      
      function findAndPress(el, depth) {
        if (depth > 5) return false;
        try {
          const role = el.role();
          const title = el.title() || el.description() || '';
          if (title === "${label}") {
            // Use AXPress action — works without visual focus
            try {
              const actions = el.actions();
              for (let a = 0; a < actions.length; a++) {
                const name = actions[a].name();
                if (name === 'AXPress' || name === 'AXConfirm' || name === 'AXPick') {
                  actions[a].perform();
                  return true;
                }
              }
            } catch(e) {}
            // Fallback to click()
            try { el.click(); return true; } catch(e) {}
          }
          try {
            const children = el.uiElements();
            for (let i = 0; i < children.length; i++) {
              if (findAndPress(children[i], depth + 1)) return true;
            }
          } catch(e) {}
        } catch(e) {}
        return false;
      }
      
      let found = false;
      const wins = proc.windows();
      for (let w = 0; w < wins.length; w++) {
        if (findAndPress(wins[w], 0)) { found = true; break; }
      }
      JSON.stringify({ clicked: found, method: 'AXPress', app: "${appName}", element: "${label}" });
    `;
    const result = JSON.parse(execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 10000 }).trim());
    return result;
  },

  /** Click at screen coordinates */
  clickAt(x, y) {
    // Use AppleScript to click at coordinates
    execSync(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`);
  },

  /** Type text — uses AXSetValue on focused field, NO activation */
  typeText(appName, text) {
    // Use System Events keystroke without activation
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execSync(`osascript -e 'tell application "System Events" to tell process "${appName}" to keystroke "${escaped}"'`);
  },

  /** Type into a specific field by label — uses AXSetValue, NO activation */
  typeIntoField(appName, fieldLabel, text) {
    // Directly set value via accessibility — completely silent
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${appName}");
      
      function findField(el, depth) {
        if (depth > 5) return null;
        try {
          const role = el.role();
          const title = el.title() || el.description() || '';
          if (['AXTextField','AXTextArea','AXComboBox','AXSearchField'].includes(role) && 
              (title.includes("${fieldLabel}") || title === "${fieldLabel}")) {
            return el;
          }
          const children = el.uiElements();
          for (let i = 0; i < children.length; i++) {
            const found = findField(children[i], depth + 1);
            if (found) return found;
          }
        } catch(e) {}
        return null;
      }
      
      const wins = proc.windows();
      let done = false;
      for (let w = 0; w < wins.length; w++) {
        const field = findField(wins[w], 0);
        if (field) {
          try { field.focused = true; } catch(e) {}
          field.value = "${text.replace(/"/g, '\\"')}";
          done = true;
          break;
        }
      }
      JSON.stringify({ typed: done, method: 'AXSetValue', field: "${fieldLabel}" });
    `;
    return JSON.parse(execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 10000 }).trim());
  },

  /** Press keyboard shortcut — targets app process directly, no activation */
  pressKeys(appName, shortcut) {
    const parts = shortcut.toLowerCase().split('+');
    const key = parts.pop();
    const mods = parts;
    
    let modStr = '';
    if (mods.includes('cmd') || mods.includes('command')) modStr += 'command down, ';
    if (mods.includes('shift')) modStr += 'shift down, ';
    if (mods.includes('alt') || mods.includes('option')) modStr += 'option down, ';
    if (mods.includes('ctrl') || mods.includes('control')) modStr += 'control down, ';
    modStr = modStr.replace(/, $/, '');
    
    // Map special key names
    const keyMap = { 'enter': 'return', 'esc': 'escape', 'del': 'delete', 'tab': 'tab', 'space': 'space',
      'up': 'up arrow', 'down': 'down arrow', 'left': 'left arrow', 'right': 'right arrow' };
    const mappedKey = keyMap[key] || key;
    
    if (mappedKey.length === 1) {
      if (modStr) {
        execSync(`osascript -e 'tell application "System Events" to keystroke "${mappedKey}" using {${modStr}}'`);
      } else {
        execSync(`osascript -e 'tell application "System Events" to keystroke "${mappedKey}"'`);
      }
    } else {
      const keyCodeMap = { 'return': 36, 'escape': 53, 'delete': 51, 'tab': 48, 'space': 49,
        'up arrow': 126, 'down arrow': 125, 'left arrow': 123, 'right arrow': 124,
        'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96 };
      const code = keyCodeMap[mappedKey];
      if (code !== undefined) {
        if (modStr) {
          execSync(`osascript -e 'tell application "System Events" to key code ${code} using {${modStr}}'`);
        } else {
          execSync(`osascript -e 'tell application "System Events" to key code ${code}'`);
        }
      }
    }
  },

  /** Click a menu item: "File > Save As" */
  clickMenu(appName, menuPath) {
    this.activate(appName);
    const parts = menuPath.split('>').map(s => s.trim());
    if (parts.length < 2) return { error: 'Format: "Menu > Item" or "Menu > Sub > Item"' };
    
    let script = `tell application "System Events" to tell process "${appName}"\n`;
    script += `  click menu item "${parts[parts.length - 1]}" of `;
    for (let i = parts.length - 2; i >= 0; i--) {
      if (i === 0) {
        script += `menu 1 of menu bar item "${parts[i]}" of menu bar 1\n`;
      } else {
        script += `menu 1 of menu item "${parts[i]}" of `;
      }
    }
    script += `end tell`;
    
    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      return { clicked: true };
    } catch (e) {
      return { clicked: false, error: e.message };
    }
  },

  /** Open an application */
  openApp(appName) {
    execSync(`open -a "${appName}"`);
    execSync('sleep 1');
  },

  /** Take screenshot of a specific app window */
  screenshotApp(appName, outputPath) {
    this.activate(appName);
    execSync('sleep 0.3');
    // Get window ID
    try {
      const winId = execSync(`osascript -l JavaScript -e '
        const se = Application("System Events");
        const proc = se.processes.byName("${appName}");
        const win = proc.windows[0];
        const pos = win.position();
        const sz = win.size();
        JSON.stringify({x: pos[0], y: pos[1], w: sz[0], h: sz[1]});
      '`, { encoding: 'utf-8' }).trim();
      const { x, y, w, h } = JSON.parse(winId);
      execSync(`screencapture -R${x},${y},${w},${h} "${outputPath}"`);
    } catch (e) {
      // Fallback: full screen
      execSync(`screencapture "${outputPath}"`);
    }
    return outputPath;
  },

  /** Get frontmost app name */
  getFrontApp() {
    return execSync(`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`, { encoding: 'utf-8' }).trim();
  },

  /** Move/resize a window */
  moveWindow(appName, x, y, w, h) {
    this.activate(appName);
    let script = `tell application "System Events" to tell process "${appName}"\n`;
    if (x !== undefined && y !== undefined) script += `  set position of window 1 to {${x}, ${y}}\n`;
    if (w !== undefined && h !== undefined) script += `  set size of window 1 to {${w}, ${h}}\n`;
    script += `end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
  },

  /** Run an arbitrary AppleScript */
  runAppleScript(script) {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8' }).trim();
  },

  /** Mouse move + click at coordinates with human-like behavior */
  humanClick(x, y) {
    // Use cliclick if available, fallback to AppleScript
    try {
      execSync(`which cliclick`, { stdio: 'ignore' });
      execSync(`cliclick m:${x},${y} c:${x},${y}`);
    } catch {
      execSync(`osascript -e '
        tell application "System Events"
          set mouseLocation to {${x}, ${y}}
          click at mouseLocation
        end tell
      '`);
    }
  },

  /** Drag from one point to another */
  drag(fromX, fromY, toX, toY) {
    try {
      execSync(`which cliclick`, { stdio: 'ignore' });
      execSync(`cliclick dd:${fromX},${fromY} du:${toX},${toY}`);
    } catch {
      execSync(`osascript -e '
        tell application "System Events"
          click at {${fromX}, ${fromY}}
          delay 0.2
          click at {${toX}, ${toY}}
        end tell
      '`);
    }
  },

  /** Scroll in the frontmost app. direction: 'up' | 'down' | 'left' | 'right', amount: pixels */
  scroll(appName, direction = 'down', amount = 5) {
    this.activate(appName);
    const dirMap = { down: '0, -', up: '0, ', left: ', 0', right: '-, 0' };
    const prefix = dirMap[direction] || '0, -';
    // Use AppleScript mouse scroll events via cliclick or osascript
    try {
      execSync(`which cliclick`, { stdio: 'ignore' });
      const axis = (direction === 'up' || direction === 'down') ? 'y' : 'x';
      const val = (direction === 'down' || direction === 'right') ? -amount : amount;
      execSync(`cliclick "kd:fn" "w:50" "ku:fn"`);
      // cliclick doesn't support scroll directly; use AppleScript CGEvent
      throw new Error('fallback');
    } catch {
      // Use Python bridge for precise scroll events
      const py = `
import Quartz
from Quartz import CGEventCreateScrollWheelEvent, kCGScrollEventUnitPixel, kCGEventScrollWheel
import time
scrollAmount = ${direction === 'up' || direction === 'left' ? amount : -amount}
for i in range(${Math.ceil(amount / 3)}):
    event = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitPixel, 1, ${direction === 'up' ? amount : -amount})
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(0.02)
`;
      try {
        execSync(`python3 -c "${py.replace(/"/g, '\\"').replace(/\n/g, '\n')}"`, { timeout: 5000 });
      } catch {
        // Final fallback: arrow keys to scroll
        const keyCode = direction === 'down' ? 125 : direction === 'up' ? 126 : direction === 'left' ? 123 : 124;
        for (let i = 0; i < Math.min(amount, 20); i++) {
          execSync(`osascript -e 'tell application "System Events" to key code ${keyCode}'`);
        }
      }
    }
  },

  /** Scroll to top/bottom of a window */
  scrollTo(appName, position = 'top') {
    this.activate(appName);
    if (position === 'top') {
      this.pressKeys(appName, 'cmd+up');
    } else if (position === 'bottom') {
      this.pressKeys(appName, 'cmd+down');
    }
  },
};


// ════════════════════════════════════════════════
//  Windows — PowerShell UI Automation Bridge
// ════════════════════════════════════════════════

const win = {
  _ps(script) {
    return execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();
  },

  listApps() {
    const raw = this._ps(`
      Add-Type -AssemblyName UIAutomationClient
      Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | 
      Select-Object ProcessName, MainWindowTitle, Id | ConvertTo-Json
    `);
    return JSON.parse(raw || '[]');
  },

  activate(appName) {
    this._ps(`
      $proc = Get-Process | Where-Object {$_.MainWindowTitle -like '*${appName}*'} | Select-Object -First 1
      if ($proc) { 
        Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
        [Native.Win]::SetForegroundWindow($proc.MainWindowHandle)
      }
    `);
  },

  scanApp(appName) {
    this.activate(appName);
    const raw = this._ps(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $auto = [System.Windows.Automation.AutomationElement]
      $root = $auto::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${appName}')
      $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if (-not $app) { '[]'; return }
      $all = $app.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $result = @()
      foreach ($el in $all) {
        $name = $el.Current.Name
        $type = $el.Current.ControlType.ProgrammaticName
        $result += @{ role = $type; label = $name }
      }
      $result | ConvertTo-Json -Depth 3
    `);
    return JSON.parse(raw || '[]');
  },

  typeText(appName, text) {
    this.activate(appName);
    this._ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${text.replace(/'/g, "''")}')
    `);
  },

  pressKeys(appName, shortcut) {
    this.activate(appName);
    // Convert to SendKeys format
    const map = { 'ctrl': '^', 'alt': '%', 'shift': '+', 'cmd': '^' };
    const parts = shortcut.split('+');
    const key = parts.pop();
    let prefix = parts.map(p => map[p.toLowerCase()] || '').join('');
    this._ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${prefix}${key}')
    `);
  },

  screenshotApp(appName, outputPath) {
    this.activate(appName);
    this._ps(`
      Add-Type -AssemblyName System.Windows.Forms
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen(0, 0, 0, 0, $screen.Size)
      $bitmap.Save('${outputPath}')
    `);
    return outputPath;
  },

  openApp(appName) {
    this._ps(`Start-Process "${appName}"`);
  },

  scroll(appName, direction = 'down', amount = 5) {
    this.activate(appName);
    const key = direction === 'down' ? '{PGDN}' : direction === 'up' ? '{PGUP}' : direction === 'left' ? '{LEFT}' : '{RIGHT}';
    for (let i = 0; i < Math.min(amount, 10); i++) {
      this._ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')`);
    }
  },

  scrollTo(appName, position = 'top') {
    this.activate(appName);
    const key = position === 'top' ? '{HOME}' : '{END}';
    this._ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^${key}')`);
  },
};


// ════════════════════════════════════════════════
//  Unified Desktop Agent API
// ════════════════════════════════════════════════

const desktop = PLATFORM === 'darwin' ? mac : PLATFORM === 'win32' ? win : null;

module.exports = {
  platform: PLATFORM,
  isSupported: !!desktop,

  /** List all running apps with windows */
  listApps: () => desktop?.listApps() || [],

  /** Bring app to front */
  activate: (app) => desktop?.activate(app),

  /** Open an application by name */
  openApp: (app) => desktop?.openApp(app),

  /** Scan an app's entire UI tree */
  scanApp: (app) => desktop?.scanApp(app),

  /** Click a button/element by its label */
  clickElement: (app, label) => desktop?.clickElement(app, label),

  /** Click at screen coordinates */
  clickAt: (x, y) => desktop?.clickAt?.(x, y) || desktop?.humanClick?.(x, y),

  /** Type text into the currently focused field */
  typeText: (app, text) => desktop?.typeText(app, text),

  /** Type into a specific field by its label */
  typeIntoField: (app, field, text) => desktop?.typeIntoField?.(app, field, text),

  /** Press keyboard shortcut (e.g., "cmd+s") */
  pressKeys: (app, shortcut) => desktop?.pressKeys(app, shortcut),

  /** Click a menu item (e.g., "File > Save As") */
  clickMenu: (app, menuPath) => desktop?.clickMenu?.(app, menuPath),

  /** Take screenshot of an app */
  screenshotApp: (app, output) => desktop?.screenshotApp(app, output || `screenshot_${Date.now()}.png`),

  /** Get frontmost app */
  getFrontApp: () => desktop?.getFrontApp?.() || null,

  /** Move/resize window */
  moveWindow: (app, x, y, w, h) => desktop?.moveWindow?.(app, x, y, w, h),

  /** Run raw AppleScript (macOS only) */
  runAppleScript: (script) => desktop?.runAppleScript?.(script),

  /** Scroll in an app: direction = 'up'|'down'|'left'|'right', amount = intensity (1-20) */
  scroll: (app, direction, amount) => desktop?.scroll?.(app, direction, amount),

  /** Scroll to top or bottom */
  scrollTo: (app, position) => desktop?.scrollTo?.(app, position),

  /** Drag from one point to another */
  drag: (fromX, fromY, toX, toY) => desktop?.drag?.(fromX, fromY, toX, toY),

  /** Synthesize agent tools from scanned desktop elements */
  synthesizeTools(elements) {
    if (!Array.isArray(elements)) return [];
    const tools = [];
    const buttons = elements.filter(e => e.type === 'button' || e.type === 'menu_item');
    const fields = elements.filter(e => ['text_input', 'text_area', 'search_field', 'combo_box'].includes(e.type));
    const menus = elements.filter(e => e.type === 'menu');

    buttons.forEach(b => {
      if (b.label) {
        const name = b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (name) tools.push({ name: `click_${name}`, kind: 'action', element: b.label, description: b.description || `Click ${b.label}`, actions: b.actions || [] });
      }
    });

    fields.forEach(f => {
      if (f.label) {
        const name = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (name) tools.push({ name: `type_${name}`, kind: 'input', element: f.label, description: f.description || `Type into ${f.label}`, params: { text: 'string' } });
      }
    });

    menus.forEach(m => {
      if (m.label) {
        tools.push({ name: `open_menu_${m.label.toLowerCase()}`, kind: 'menu', element: m.label, description: m.description || `Open ${m.label} menu` });
      }
    });

    return tools;
  },
};
