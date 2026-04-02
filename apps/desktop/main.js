const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");

const DEFAULT_WEB_URL = process.env.MOON_WEB_URL || "https://moon-production-c740.up.railway.app";
let mainWindow = null;
let dashboardWindow = null;

function getPreloadPath() {
  return path.join(__dirname, "preload.js");
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

function createDashboardWindow(targetPath = "/dashboard") {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.focus();
    return dashboardWindow;
  }

  dashboardWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#111318",
    title: "MOON Dashboard",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  dashboardWindow.loadURL(new URL(targetPath, DEFAULT_WEB_URL).toString());
  dashboardWindow.once("ready-to-show", () => {
    dashboardWindow?.show();
  });
  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });

  return dashboardWindow;
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
  themeSource: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  platform: process.platform,
}));

ipcMain.handle("moon:open-dashboard", (_event, targetPath) => {
  createDashboardWindow(targetPath || "/dashboard");
  return true;
});

ipcMain.handle("moon:open-external", (_event, url) => {
  if (!url) {
    return false;
  }

  shell.openExternal(url);
  return true;
});
