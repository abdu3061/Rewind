// IPC wrapper placeholders
// Implement calls to window.rewind (exposed by preload) from the renderer

export const getSessions = async (): Promise<unknown[]> => {
  throw new Error('Not implemented');
};

export const getSessionEvents = async (): Promise<unknown[]> => {
  throw new Error('Not implemented');
};

export const requestRecovery = async (): Promise<unknown> => {
  throw new Error('Not implemented');
};
