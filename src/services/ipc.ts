// IPC wrapper placeholders
// Implement calls to window.rewind (exposed by preload) from the renderer

export const getSessions = async (): Promise<any[]> => {
  throw new Error('Not implemented')
}

export const getSessionEvents = async (sessionId: string): Promise<any[]> => {
  throw new Error('Not implemented')
}

export const requestRecovery = async (payload: any): Promise<any> => {
  throw new Error('Not implemented')
}
