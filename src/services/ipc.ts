// Wrapper to match the API exposed by preload.ts
export const getSessions = async (): Promise<any[]> => {
  return (window as any).rewind?.getSessions() || []
}

export const getSessionEvents = async (sessionId: string): Promise<any[]> => {
  return (window as any).rewind?.getSessionEvents(sessionId) || []
}

export const requestRecovery = async (payload: any): Promise<any> => {
  return (window as any).rewind?.requestRecovery(payload) || { success: false }
}
