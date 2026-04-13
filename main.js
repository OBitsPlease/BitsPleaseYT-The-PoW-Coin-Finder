const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const scraper = require('./scraper');

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

// IPC: Open external URL
ipcMain.handle('open-external', async (event, url) => {
  if (isExternalUrl(url)) {
    await shell.openExternal(url);
  }
  return true;
});
