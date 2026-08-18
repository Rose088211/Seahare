const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});

contextBridge.exposeInMainWorld('floatingTerminal', {
  create: (opts) => ipcRenderer.invoke('terminal:create', opts || {}),
  write: (id, data) => ipcRenderer.send('terminal:write', id, data),
  kill: (id) => ipcRenderer.send('terminal:kill', id),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  onData: (callback) => {
    const listener = (_event, id, data) => callback(id, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onExit: (callback) => {
    const listener = (_event, id, code, error) => callback(id, code, error);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
});

contextBridge.exposeInMainWorld('markdownFile', {
  open: () => ipcRenderer.invoke('markdown:open'),
  save: (filePath, content) => ipcRenderer.invoke('markdown:save', filePath, content),
});
