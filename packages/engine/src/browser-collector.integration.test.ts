import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createDefaultSettings,
  type BrowserTransportListener,
  type NativeBrowserState,
  type Result,
} from "@rewind/contracts";
import { SecureStorage } from "@rewind/storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../storage/src/secure-fixtures.test-support";
import { BrowserCollector } from "./browser-collector";
import { SessionCoordinator } from "./session-coordinator";
import { SessionService } from "./session-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
const marker = "SyntheticBrowserEvidenceNeedle35792";
function fixture() {
  const root = newSecureFixture(),
    key = randomBytes(32),
    file = join(root, "browser-history.sqlite");
  const storages: SecureStorage[] = [];
  const coordinators: SessionCoordinator[] = [];
  let settings = {
    ...createDefaultSettings(),
    browserCollectionConsent: true,
    excludedSiteHosts: ["excluded.test"],
  };
  cleanups.push(async () => {
    for (const coordinator of coordinators) await coordinator.shutdown();
    for (const storage of storages) await storage.close();
    key.fill(0);
    removeSecureFixture(root);
  });
  function open() {
    const storage = new SecureStorage(file, key);
    storages.push(storage);
    let listener!: BrowserTransportListener;
    let autoAck = true;
    const states: NativeBrowserState[] = [];
    const peer = {
      id: randomUUID(),
      origin: `chrome-extension://${"a".repeat(32)}/`,
      browser: "chrome" as const,
    };
    const connectionId = randomUUID();
    const source = new BrowserCollector({
      transport: {
        setListener: (value) => {
          listener = value;
        },
        send: (_id, state) => {
          states.push(state);
          if (!state.authority && autoAck)
            queueMicrotask(() =>
              listener.message(peer.id, {
                version: 2,
                type: "stopped",
                connectionId,
                revision: state.revision,
              }),
            );
          return { ok: true, value: undefined };
        },
        disconnect: () => listener.disconnected(peer.id),
      },
    });
    const windows = {
      id: "windows",
      start: ok,
      resume: ok,
      stop: ok,
      pause: ok,
    };
    const coordinator = new SessionCoordinator({
      mode: "repository",
      storage,
      collectors: { windows, browser: source },
      service: new SessionService({
        newId: randomUUID,
        now: () => new Date().toISOString(),
      }),
      getSettings: () => settings,
      authorizeResource: async (event, policy) =>
        source.authorize(event, policy),
    });
    coordinators.push(coordinator);
    listener.connected(peer);
    listener.message(peer.id, {
      version: 2,
      type: "hello",
      connectionId,
      profileId: randomUUID(),
    });
    const lease = () => states.filter((state) => state.authority).at(-1)!;
    function visit(
      state: NativeBrowserState,
      sequence = 1,
      url = "https://synthetic.test/work",
    ) {
      const authority = state.authority!;
      listener.message(peer.id, {
        version: 2,
        type: "visit",
        connectionId,
        sequence,
        sessionId: authority.sessionId,
        generationId: authority.generationId,
        capability: authority.capability,
        occurredAt: "2020-01-01T00:00:00.000Z",
        incognito: false,
        focused: true,
        url,
        title: marker,
      });
    }
    return {
      storage,
      coordinator,
      source,
      listener,
      states,
      lease,
      visit,
      ack: () =>
        listener.message(peer.id, {
          version: 2,
          type: "stopped",
          connectionId,
          revision: states.at(-1)!.revision,
        }),
      autoAck: (value: boolean) => {
        autoAck = value;
      },
    };
  }
  return {
    root,
    file,
    open,
    deny: () => {
      settings = { ...settings, browserCollectionConsent: false };
    },
  };
}

it("publishes staged browser observations into encrypted history/FTS, drains pause/end, rotates resume and reopens without approval", async () => {
  const f = fixture(),
    first = f.open();
  expect(first.states.every((state) => state.authority === null)).toBe(true);
  expect((await first.coordinator.execute("start")).ok).toBe(true);
  await expect.poll(() => first.lease()?.authority).toBeTruthy();
  const original = first.lease(),
    sessionId = original.authority!.sessionId;
  first.visit(original, 1, "https://sub.excluded.test/page");
  first.visit(original, 2);
  await expect.poll(() => first.source.status().captured).toBe(1);
  const found = await first.storage.timeline({
    sessionId,
    text: marker,
    types: ["browser-visit"],
    limit: 10,
  });
  expect(found).toMatchObject({
    ok: true,
    value: [
      expect.objectContaining({
        type: "browser-visit",
        sessionId,
        payload: expect.objectContaining({
          browser: "chrome",
          title: marker,
          url: "https://synthetic.test/work",
          endedAt: null,
        }),
      }),
    ],
  });
  expect(await first.storage.timeline({ text: "excluded", limit: 10 })).toEqual(
    { ok: true, value: [] },
  );
  first.autoAck(false);
  let paused = false;
  const stopping = first.coordinator.execute("pause").then((result) => {
    paused = true;
    return result;
  });
  await expect.poll(() => first.states.at(-1)?.authority === null).toBe(true);
  expect(paused).toBe(false);
  first.visit(original, 3); // Queued old activity is fenced immediately, before pause acknowledgement.
  first.ack();
  expect((await stopping).ok).toBe(true);
  first.autoAck(true);
  expect((await first.coordinator.execute("resume")).ok).toBe(true);
  await expect
    .poll(() => first.lease()?.authority?.generationId)
    .not.toBe(original.authority!.generationId);
  expect(first.lease().authority!.capability).not.toBe(
    original.authority!.capability,
  );
  first.visit(first.lease());
  await expect.poll(() => first.source.status().captured).toBe(1);
  expect((await first.coordinator.execute("end")).ok).toBe(true);
  expect((await first.coordinator.shutdown()).ok).toBe(true);
  for (const name of readdirSync(f.root)) {
    expect(readFileSync(join(f.root, name)).includes(Buffer.from(marker))).toBe(
      false,
    );
    expect(
      readFileSync(join(f.root, name)).includes(
        Buffer.from("synthetic.test/work"),
      ),
    ).toBe(false);
  }
  f.deny();
  const second = f.open();
  expect((await second.coordinator.initialize()).ok).toBe(true);
  expect(second.coordinator.getActiveGenerationId()).toBeNull();
  const restored = await second.storage.timeline({
    sessionId,
    text: marker,
    limit: 10,
  });
  expect(restored.ok && restored.value).toHaveLength(2);
  expect(second.states.every((state) => state.authority === null)).toBe(true);
  expect((await second.coordinator.execute("start")).ok).toBe(true);
  expect(second.coordinator.getStatus().collection).toBe("off");
  expect(second.source.status().state).toBe("off");
  expect((await second.coordinator.shutdown()).ok).toBe(true);
});
