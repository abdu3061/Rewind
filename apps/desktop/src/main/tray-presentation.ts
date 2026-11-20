import type { NotchWindow } from "./notch-window";

/** Native tray gestures use the same restore path as notch and single-instance activation. */
export function trayPresentation(ports: {
  desktop: () => { minimize(): void } | null;
  notch: NotchWindow;
  failed: () => void;
}) {
  return {
    open: () => ports.notch.open(),
    hide: () => ports.notch.hide(),
    show: () => {
      ports.desktop()?.minimize();
      void ports.notch.showCompact().catch(ports.failed);
    },
  };
}
