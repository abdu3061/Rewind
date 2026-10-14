import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Load the renderer's index.html
  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// IPC handlers (placeholders) - these should be implemented in api/*
ipcMain.handle('getSessions', async () => {
  return [] // TODO: call session manager
})

ipcMain.handle('getSessionEvents', async (event, sessionId: string) => {
  return [] // TODO: return events for sessionId
})

ipcMain.handle('requestRecovery', async (event, payload) => {
  return { success: false, message: 'not implemented' }
})
