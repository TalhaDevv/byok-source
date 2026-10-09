const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cortex", {
  getState: () => ipcRenderer.invoke("state:get"),
  setState: (patch) => ipcRenderer.invoke("state:set", patch),
  setKey: (key) => ipcRenderer.invoke("key:set", key),
  keyStatus: () => ipcRenderer.invoke("key:status"),
  listModels: () => ipcRenderer.invoke("models:list"),
  runtimeStatus: () => ipcRenderer.invoke("runtime:status"),
  runtimeActivity: () => ipcRenderer.invoke("runtime:activity"),
  runtimeToggle: (on) => ipcRenderer.invoke("runtime:toggle", on),
  runtimeApplyModel: () => ipcRenderer.invoke("runtime:applyModel"),
  runtimeExport: () => ipcRenderer.invoke("runtime:export"),
  runtimeUninstall: () => ipcRenderer.invoke("runtime:uninstall"),
  cursorStatus: () => ipcRenderer.invoke("cursor:status"),
  cursorToggle: (on) => ipcRenderer.invoke("cursor:toggle", on),
  cursorModels: () => ipcRenderer.invoke("cursor:models"),
  cursorAdd: (model) => ipcRenderer.invoke("cursor:add", model),
  cursorAddMany: (models) => ipcRenderer.invoke("cursor:addMany", models),
  cursorRemove: (id) => ipcRenderer.invoke("cursor:remove", id),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  win: {
    min: () => ipcRenderer.send("win:min"),
    max: () => ipcRenderer.send("win:max"),
    close: () => ipcRenderer.send("win:close"),
  },
});
