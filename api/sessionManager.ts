// Session manager placeholder

export type Session = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export async function listSessions(): Promise<Session[]> {
  // TODO: read from DB
  return []
}

export async function getSessionEvents(sessionId: string): Promise<any[]> {
  // TODO: read events from DB
  return []
}
