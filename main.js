const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const scraper = require('./scraper');

function configureLocalDataPaths() {
  if (process.platform !== 'win32') return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;

  // Keep Electron state in LOCALAPPDATA so it never depends on OneDrive-backed folders.
  const baseDir = path.join(localAppData, 'BitsPleaseYT The PoW Coin Finder');
  app.setPath('userData', path.join(baseDir, 'User Data'));
  app.setPath('sessionData', path.join(baseDir, 'Session Data'));
  app.setPath('logs', path.join(baseDir, 'Logs'));
}

configureLocalDataPaths();

function isExternalUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'BitsPleaseYT The PoW Coin Finder.'
  });

  // Open external links in the OS default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isExternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadFile('electron_mockup.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Fetch coins
ipcMain.handle('fetch-coins', async () => {
  return await scraper.fetchNewPOWCoins();
});

// IPC: Fetch MiningPoolStats PoW directory
ipcMain.handle('fetch-pow-directory', async () => {
  return await scraper.fetchMiningPoolStatsPOWCoins({});
});

// IPC: Prompt login (placeholder)
ipcMain.handle('prompt-login', async () => {
  // In a real app, show a login dialog and return credentials
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    title: 'Login Required',
    message: 'Bitcointalk.org requires login. Please implement login UI.'
  });
  return { login: false };
});

// IPC: Fetch WhatToMine profitability
ipcMain.handle('fetch-wtm-profitability', async (event, algoInputs) => {
  if (!Array.isArray(algoInputs)) return { coins: [], btcPrice: 0 };
  // Sanitize each entry: only allow safe alphanumeric keys and numeric values.
  const sanitized = algoInputs
    .filter(a => a && typeof a.key === 'string' && /^[a-z0-9_]{1,32}$/i.test(a.key))
    .map(a => ({
      key: String(a.key).toLowerCase(),
      hrValue: Math.max(0, Number(a.hrValue) || 0),
      powerWatts: Math.max(0, Number(a.powerWatts) || 0)
    }));
  return await scraper.fetchWhatToMineProfitability(sanitized);
});

// IPC: Fetch calendar events
ipcMain.handle('fetch-calendar', async () => {
  return await scraper.fetchCalendarEvents();
});

// IPC: Open external URL
ipcMain.handle('open-external', async (event, url) => {
  if (isExternalUrl(url)) {
    await shell.openExternal(url);
  }
  return true;
});
