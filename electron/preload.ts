import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('rewind', {
  getSessions: () => ipcRenderer.invoke('getSessions'),
  getSessionEvents: (sessionId: string) => ipcRenderer.invoke('getSessionEvents', sessionId),
  requestRecovery: (payload: any) => ipcRenderer.invoke('requestRecovery', payload)
})
