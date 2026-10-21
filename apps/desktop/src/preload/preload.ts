import { contextBridge, ipcRenderer } from 'electron';
import {
  failure,
  noArgumentsSchema,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  sessionResponseSchema,
  sessionStateSchema,
  type DesktopApi,
  type Result,
  type SessionAction,
  type SessionState,
} from '@rewind/contracts';

function command(action: SessionAction) {
  return async (...args: unknown[]): Promise<Result<SessionState>> => {
    if (!noArgumentsSchema.safeParse(args).success)
      return failure('INVALID_INPUT', 'This method accepts no arguments.');
    try {
      const parsed = sessionResponseSchema.safeParse(
        await ipcRenderer.invoke(SESSION_CHANNEL, { action }),
      );
      return parsed.success
        ? parsed.data
        : failure('INTERNAL', 'The desktop returned an invalid response.');
    } catch {
      return failure('UNAVAILABLE', 'The desktop service is unavailable.');
    }
  };
}

const api: DesktopApi = {
  sessions: {
    get: command('get'),
    start: command('start'),
    pause: command('pause'),
    resume: command('resume'),
    end: command('end'),
    onChanged(listener) {
      if (typeof listener !== 'function') throw new TypeError('A session listener is required.');
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = sessionStateSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(SESSION_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(SESSION_CHANGED_CHANNEL, handler);
    },
  },
};
contextBridge.exposeInMainWorld('rewind', api);
