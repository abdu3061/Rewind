import type {
  NativeBrowserMessage,
  NativeBrowserState,
} from "./browser-transport";
import type { Result } from "./common";

/** Created only by the authenticated native adapter, never from an extension's asserted fields. */
export interface BrowserPeer {
  id: string;
  origin: string;
  browser: "chrome" | "edge";
}
export interface BrowserTransportListener {
  connected(peer: BrowserPeer): void;
  message(peerId: string, message: NativeBrowserMessage): void;
  disconnected(peerId: string): void;
  unavailable(): void;
}
/** Passive authenticated communication; session/collection authority belongs to the engine. */
export interface BrowserTransport {
  setListener(listener: BrowserTransportListener): void;
  send(peerId: string, state: NativeBrowserState): Result<void>;
  disconnect(peerId: string): void;
}
