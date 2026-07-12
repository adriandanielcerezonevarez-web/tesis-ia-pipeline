const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.ico');
  const loginPath = path.join(__dirname, 'login.html');

  const winOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  };

  // sólo seteamos icon si existe, si no electron tira warning
  if (fs.existsSync(iconPath)) winOptions.icon = iconPath;

  mainWindow = new BrowserWindow(winOptions);
  mainWindow.maximize();

  // ruta absoluta, así da igual desde dónde se lance
  mainWindow.loadFile(loginPath).catch(err => {
    console.error('no se pudo cargar login.html:', err);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // devtools si arrancamos en modo dev
  if (process.argv.includes('--dev') || process.env.ELECTRON_ENABLE_LOGGING === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // en mac la convención es dejar la app viva aunque cierres ventanas
  if (process.platform !== 'darwin') app.quit();
});
