import type { DesktopApi } from '@rewind/contracts';

declare global {
  interface Window {
    rewind: DesktopApi;
  }
}
