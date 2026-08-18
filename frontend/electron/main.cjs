const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow = null;
let backendProcess = null;

const logDir = path.join(process.env.LOCALAPPDATA || __dirname, 'Seahare');
const logFile = path.join(logDir, 'desktop.log');
function log(message) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Diagnostics must not prevent startup.
  }
}

process.on('uncaughtException', (error) => log(`uncaughtException: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandledRejection: ${error?.stack || error}`));
log(`main loaded; execPath=${process.execPath}`);

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1000);
    socket.once('error', onError);
    socket.once('timeout', onError);
    socket.connect(port, host, () => {
      socket.end();
      resolve(true);
    });
  });
}

function requestJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 16384) body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.setTimeout(1000, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function isSeahareHealthy() {
  const response = await requestJson('http://127.0.0.1:8765/api/health');
  return response?.status === 200 && response.data?.ok === true && response.data?.service === 'seahare';
}

async function waitForRenderer(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson('http://127.0.0.1:5173');
    if (response?.status === 200) return;
    await sleep(200);
  }
  throw new Error('Timeout waiting for the Vite development server.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startBackend() {
  if (await isSeahareHealthy()) {
    log('using existing Seahare backend');
    console.log('Using an existing Seahare backend on port 8765.');
    return false;
  }

  const isPortInUse = await checkPort(8765);
  if (isPortInUse) {
    log('port 8765 conflict with non-Seahare service');
    throw new Error('Port 8765 is occupied by a service that is not Seahare.');
  }

  console.log('Port 8765 is free. Starting backend...');
  const isDev = !app.isPackaged;
  if (isDev) {
    const rootDir = path.resolve(__dirname, '../..');
    console.log(`Starting development backend in CWD: ${rootDir}`);
    backendProcess = spawn('python', ['-m', 'backend'], {
      cwd: rootDir,
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    const backendExe = path.join(process.resourcesPath, 'backend', 'seahare-backend.exe');
    console.log(`Starting production backend: ${backendExe}`);
    backendProcess = spawn(backendExe, [], {
      cwd: path.dirname(backendExe),
      windowsHide: true,
      stdio: 'ignore',
    });
  }

  let processExited = false;
  let exitError = null;

  backendProcess.on('error', (err) => {
    processExited = true;
    exitError = err;
    console.error('Backend process error:', err);
  });

  backendProcess.once('exit', (code, signal) => {
    processExited = true;
    console.log(`Backend process exited with code: ${code}, signal: ${signal}`);
    if (code !== 0 && code !== null) {
      exitError = new Error(`Backend process exited with code ${code}`);
    }
  });

  const startTime = Date.now();
  const timeoutMs = 15000;

  while (true) {
    if (processExited) {
      throw exitError || new Error('Backend process exited unexpectedly during startup.');
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error('Timeout waiting for backend to become ready (15 seconds).');
    }

    const ready = await isSeahareHealthy();
    if (ready) {
      break;
    }
    await sleep(200);
  }

  console.log('Backend is ready!');
  return true;
}

// ---- Floating workspace — real PTY via node-pty helper process ----
const terminalSessions = new Map();
let ptyHelper = null;

const SHELL_PATHS = [
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
  'C:/Program Files/PowerShell/7/pwsh.exe',
  path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  'D:/Git/bin/bash.exe',
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
];

function findShell(explicit) {
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    const label = path.basename(explicit.trim()).replace('.exe', '');
    return { cmd: explicit.trim(), label };
  }
  for (const candidate of SHELL_PATHS) {
    try {
      if (fs.existsSync(candidate)) {
        const name = path.basename(candidate).replace('.exe', '');
        const label = name === 'pwsh' ? 'powershell' : name;
        log(`found shell: ${candidate} -> label=${label}`);
        return { cmd: candidate, label };
      }
    } catch {
      /* keep looking */
    }
  }
  const fallback = process.env.ComSpec || 'cmd.exe';
  log(`no shell found, fallback to: ${fallback}`);
  return { cmd: fallback, label: 'cmd' };
}

function startPtyHelper() {
  if (ptyHelper) return;
  const helperPath = path.join(__dirname, 'pty-helper.cjs');
  log(`starting PTY helper: helper=${helperPath}`);

  // 查找 node-pty 模块位置
  // 开发模式: frontend/node_modules/node-pty
  // 生产模式(新): extraResources 复制到 app/node_modules/node-pty
  // 生产模式(旧): resources/node-pty/
  const defaultPath = path.join(__dirname, '..', 'node_modules');
  const fallbackPath = path.join(__dirname, '..', '..');
  let nodeModulesPath = defaultPath;
  if (!fs.existsSync(path.join(nodeModulesPath, 'node-pty'))) {
    if (fs.existsSync(path.join(fallbackPath, 'node-pty'))) {
      nodeModulesPath = fallbackPath;
      log(`PTY helper found node-pty at fallback: ${fallbackPath}`);
    } else {
      log(`node-pty not found in ${defaultPath} or ${fallbackPath}`);
    }
  }
  log(`PTY helper NODE_PATH: ${nodeModulesPath}`);

  ptyHelper = spawn('node', [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: nodeModulesPath },
    windowsHide: true,
  });
  log(`PTY helper spawned: pid=${ptyHelper.pid || '(no pid)'}`);
  let buffer = '';
  ptyHelper.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'data' && msg.id && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', msg.id, msg.data);
        } else if (msg.type === 'exit' && msg.id && mainWindow && !mainWindow.isDestroyed()) {
          terminalSessions.delete(msg.id);
          mainWindow.webContents.send('terminal:exit', msg.id, msg.code);
        } else if (msg.type === 'error' && msg.id) {
          terminalSessions.delete(msg.id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal:exit', msg.id, -1, msg.message);
          }
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  });
  ptyHelper.stderr.on('data', (chunk) => {
    log(`PTY helper stderr: ${chunk.toString('utf8').trim()}`);
  });
  ptyHelper.on('exit', (code, signal) => {
    log(`PTY helper exited: code=${code} signal=${signal}`);
    ptyHelper = null;
    terminalSessions.clear();
  });
  ptyHelper.on('error', (err) => {
    log(`PTY helper error: ${err.message}`);
    ptyHelper = null;
  });
}

function sendToHelper(msg) {
  if (!ptyHelper || !ptyHelper.stdin || ptyHelper.stdin.destroyed) {
    log(`sendToHelper skipped (helper not ready): msg=${msg.type}`);
    return;
  }
  try {
    ptyHelper.stdin.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    log(`sendToHelper error: ${err.message}`);
  }
}

function startTerminal(win, opts) {
  startPtyHelper();
  const shellInfo = findShell(opts && opts.shell);
  const cwd = (opts && opts.cwd) || process.env.USERPROFILE || os.homedir();
  const isPowerShell = shellInfo.label === 'powershell';
  const isBash = shellInfo.label === 'bash';
  let args = [];
  if (isPowerShell) {
    const profilePath = path.join(__dirname, 'ps-profile.ps1');
    args = ['-NoLogo', '-NoExit', '-Command', '. "' + profilePath + '"'];
  } else if (isBash) {
    args = ['--noprofile', '--norc', '-i'];
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  terminalSessions.set(id, { id, shell: shellInfo.label });
  log(`startTerminal: id=${id} shell=${shellInfo.label} cmd=${shellInfo.cmd}`);
  sendToHelper({
    type: 'spawn',
    id,
    file: shellInfo.cmd,
    args,
    cwd,
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    },
    cols: 80,
    rows: 24,
  });
  return { id, shell: shellInfo.label };
}

function stopTerminal(id) {
  if (id && terminalSessions.has(id)) {
    sendToHelper({ type: 'kill', id });
    terminalSessions.delete(id);
  }
}

function stopAllTerminals() {
  for (const id of [...terminalSessions.keys()]) stopTerminal(id);
  if (ptyHelper) {
    try { sendToHelper({ type: 'shutdown' }); } catch {}
    ptyHelper = null;
  }
}

function registerTerminalIpc() {
  ipcMain.handle('terminal:create', (_event, opts) => {
    if (!mainWindow) throw new Error('main window is not ready');
    return startTerminal(mainWindow, opts || {});
  });
  ipcMain.on('terminal:write', (_event, id, data) => {
    if (id && terminalSessions.has(id)) {
      sendToHelper({ type: 'write', id, data: String(data) });
    }
  });
  ipcMain.on('terminal:kill', (_event, id) => stopTerminal(id));
  ipcMain.on('terminal:resize', (_event, id, cols, rows) => {
    if (id && terminalSessions.has(id)) {
      sendToHelper({ type: 'resize', id, cols: Math.round(cols), rows: Math.round(rows) });
    }
  });

  ipcMain.handle('markdown:open', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 Markdown 笔记',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, name: path.basename(filePath), content: fs.readFileSync(filePath, 'utf8') };
  });
  ipcMain.handle('markdown:save', async (_event, filePath, content) => {
    if (!mainWindow) return null;
    let target = filePath;
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存 Markdown 笔记',
        defaultPath: 'note.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    return { path: target, name: path.basename(target) };
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    title: 'Seahare',
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0f',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`window load failed: ${code} ${description} ${url}`);
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopAllTerminals();
  });
}

const additionalData = { myKey: 'seahare-app' };
const gotTheLock = app.requestSingleInstanceLock(additionalData);
log(`single instance lock=${gotTheLock}`);

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log(`app ready; packaged=${app.isPackaged}; appPath=${app.getAppPath()}`);
    try {
      await startBackend();
      if (!app.isPackaged) await waitForRenderer();
      registerTerminalIpc();
      createWindow();
      log('main window created');
    } catch (err) {
      log(`startup failed: ${err.stack || err}`);
      console.error('Failed to initialize application:', err);
      dialog.showErrorBox(
        '后端启动失败',
        `Seahare 后端服务启动失败，程序将退出。\n错误信息: ${err.message}`
      );
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopAllTerminals();
  if (backendProcess) {
    console.log('Terminating backend process...');
    try {
      backendProcess.kill();
    } catch (e) {
      console.error('Failed to kill backend process:', e);
    }
    backendProcess = null;
  }
});