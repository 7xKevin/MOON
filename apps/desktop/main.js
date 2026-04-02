const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");

const DEFAULT_WEB_URL = process.env.MOON_WEB_URL || "https://moon-production-c740.up.railway.app";
const DEFAULT_UPDATE_FEED_URL = process.env.MOON_DESKTOP_UPDATE_FEED_URL || new URL('/api/desktop/release.json', DEFAULT_WEB_URL).toString();
let mainWindow = null;

function getPreloadPath() {
  return path.join(__dirname, "preload.js");
}

function normalizeVersion(value) {
  return String(value || '0.0.0')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  const max = Math.max(a.length, b.length);

  for (let index = 0; index < max; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#15171d",
    title: "MOON Desktop",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function navigateMainWindow(targetPath = '/dashboard') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  mainWindow.loadURL(new URL(targetPath, DEFAULT_WEB_URL).toString());
  mainWindow.focus();
  return true;
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("moon:get-shell-context", () => ({
  appName: "MOON Desktop",
  appVersion: app.getVersion(),
  webUrl: DEFAULT_WEB_URL,
  updateFeedUrl: DEFAULT_UPDATE_FEED_URL,
  themeSource: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  platform: process.platform,
}));

ipcMain.handle("moon:open-dashboard", (_event, targetPath) => {
  return navigateMainWindow(targetPath || '/dashboard');
});

ipcMain.handle("moon:navigate-main", (_event, targetPath) => {
  return navigateMainWindow(targetPath || '/');
});

ipcMain.handle("moon:open-external", (_event, url) => {
  if (!url) {
    return false;
  }

  shell.openExternal(url);
  return true;
});


ipcMain.handle("moon:check-for-updates", async () => {
  const currentVersion = app.getVersion();

  try {
    const response = await fetch(DEFAULT_UPDATE_FEED_URL, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Update feed returned ' + response.status);
    }

    const release = await response.json();
    const remoteVersion = release?.version || currentVersion;
    const hasUpdate = compareVersions(remoteVersion, currentVersion) > 0;

    return {
      ok: true,
      currentVersion,
      remoteVersion,
      hasUpdate,
      release,
      downloadUrl: release?.windows?.downloadUrl || null,
      notesUrl: release?.windows?.notesUrl || null,
    };
  } catch (error) {
    return {
      ok: false,
      currentVersion,
      remoteVersion: currentVersion,
      hasUpdate: false,
      error: error.message,
      release: null,
      downloadUrl: null,
      notesUrl: null,
    };
  }
});
