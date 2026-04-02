const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("MOON_DESKTOP", {
  getShellContext() {
    return ipcRenderer.invoke("moon:get-shell-context");
  },
  openDashboard(targetPath) {
    return ipcRenderer.invoke("moon:open-dashboard", targetPath);
  },
  openExternal(url) {
    return ipcRenderer.invoke("moon:open-external", url);
  },
  checkForUpdates() {
    return ipcRenderer.invoke("moon:check-for-updates");
  },
});
