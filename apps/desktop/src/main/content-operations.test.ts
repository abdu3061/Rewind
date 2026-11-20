import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  fileTextSearchResponseSchema,
  type Session,
  type SnapshotCapture,
} from "@rewind/contracts";
import { SessionCoordinator, SessionService } from "@rewind/engine";
import { SecureStorage } from "@rewind/storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";
import { ContentOperations } from "./content-operations";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = newSecureFixture(),
    key = randomBytes(32),
    generation = randomUUID(),
    folderId = randomUUID();
  let revision = 0,
    content: ContentOperations | null = null;
  const storage = new SecureStorage(join(root, "history.sqlite"), key, {
    evidenceChanged: (mutation) => {
      if (content?.referencesRemoved(mutation.retainsVersion)) {
        revision++;
        content.invalidate();
      }
    },
  });
  const coordinator = new SessionCoordinator({
    mode: "session-only",
    service: new SessionService({
      newId: randomUUID,
      now: () => new Date().toISOString(),
    }),
  });
  cleanups.push(async () => {
    await content?.close();
    await coordinator.shutdown();
    await storage.close();
    key.fill(0);
    removeSecureFixture(root);
  });
  expect((await storage.open()).ok).toBe(true);
  const settings = {
    ...createDefaultSettings(),
    folderCollectionConsent: true,
    protectedFolderIds: [folderId],
  };
  expect((await storage.saveSettings(settings)).ok).toBe(true);
  const session: Session = {
    id: randomUUID(),
    startedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    status: "active",
  };
  expect((await storage.repositories.sessions.save(session)).ok).toBe(true);
  expect(
    (
      await storage.snapshots.saveFolder({
        id: folderId,
        absolutePath: root,
        osIdentity: "synthetic:content-folder",
        selectedAt: session.startedAt,
      })
    ).ok,
  ).toBe(true);
  content = new ContentOperations({
    storage,
    coordinator,
    authority: () => ({ generation, revision }),
    settings: () => settings,
    session: () => session,
    available: () => true,
    indexingAllowed: () => true,
    automaticAllowed: () => false,
    previewActive: () => false,
    changed: vi.fn(),
    fault: vi.fn(),
  });
  let serial = 0;
  async function capture(text: string, capturedAt = new Date().toISOString()) {
    const id = randomUUID(),
      bytes = Buffer.from(text),
      name = `synthetic-${++serial}.txt`;
    const source: SnapshotCapture = {
      file: {
        id,
        displayName: name,
        identity: {
          kind: "verified-path",
          absolutePath: join(root, name),
          verifiedAt: capturedAt,
        },
      },
      version: {
        id: randomUUID(),
        fileId: id,
        sessionId: session.id,
        capturedAt,
        mediaType: "text/plain",
        byteLength: bytes.length,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      },
      binding: { folderId, relativePath: name, osIdentity: `synthetic:${id}` },
      bytes,
    };
    expect(
      (
        await storage.snapshots.capture(
          source,
          {
            id: randomUUID(),
            sessionId: session.id,
            occurredAt: capturedAt,
            type: "file-change",
            source: "filesystem",
            payload: { fileId: id, change: "captured" },
          },
          () => true,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await storage.fileText.save(
          {
            versionId: source.version.id,
            contentHash: source.version.contentHash,
            revision: 1,
            extraction: {
              state: "available",
              format: "utf8",
              text,
              truncated: false,
              pagesRead: null,
              totalPages: null,
            },
            indexedAt: new Date().toISOString(),
          },
          () => true,
        )
      ).ok,
    ).toBe(true);
    return source;
  }
  const search = async (text: string) =>
    fileTextSearchResponseSchema.parse(
      await content!.execute({
        kind: "content.search",
        query: { text, limit: 25 },
      }),
    );
  return {
    root,
    storage,
    content,
    settings,
    session,
    capture,
    search,
    revision: () => revision,
  };
}

it("invalidates displayed content before source expiration commits and preserves a kept result through unrelated expiration", async () => {
  const f = await fixture(),
    kept = await f.capture("SyntheticKeptBody42917");
  expect(
    (
      await f.storage.repositories.checkpoints.save({
        id: randomUUID(),
        name: "Kept body source",
        sessionId: f.session.id,
        createdAt: new Date().toISOString(),
        kept: true,
        fileVersionIds: [kept.version.id],
        activityIds: [],
        browserVisitIds: [],
        projectReferences: [],
      })
    ).ok,
  ).toBe(true);
  const result = await f.search("SyntheticKeptBody42917");
  expect(result).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: kept.version.id } }] },
  });
  const before = f.revision();
  await f.capture(
    "SyntheticExpiredBody42917",
    new Date(Date.now() - 80 * 3600000).toISOString(),
  );
  expect((await f.content.execute({ kind: "content.state" })).ok).toBe(true);
  expect(f.revision()).toBe(before);
  const transient = await f.capture("SyntheticRemovedBody42917");
  expect(await f.search("SyntheticRemovedBody42917")).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: transient.version.id } }] },
  });
  expect(
    (await f.storage.cleanup(new Date(Date.now() + 80 * 3600000))).ok,
  ).toBe(true);
  expect(f.revision()).toBeGreaterThan(before);
  expect(await f.search("SyntheticRemovedBody42917")).toMatchObject({
    ok: true,
    value: { hits: [] },
  });
  expect(await f.search("SyntheticKeptBody42917")).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: kept.version.id } }] },
  });
});

it("applies current folder exclusions to retained body hits and releases displayed-source tracking when the search screen closes", async () => {
  const f = await fixture(),
    source = await f.capture("SyntheticPolicyBody42917");
  expect(await f.search("SyntheticPolicyBody42917")).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: source.version.id } }] },
  });
  expect(f.content.referencesRemoved(() => false)).toBe(true);
  expect(await f.content.execute({ kind: "content.clear-search" })).toEqual({
    ok: true,
    value: true,
  });
  expect(f.content.referencesRemoved(() => false)).toBe(false);
  f.settings.excludedFolderPaths = [f.root.toUpperCase()];
  f.content.invalidate();
  expect(await f.search("SyntheticPolicyBody42917")).toMatchObject({
    ok: true,
    value: { hits: [], hasMore: false },
  });
  f.settings.excludedFolderPaths = [];
  f.content.invalidate();
  expect(await f.search("SyntheticPolicyBody42917")).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: source.version.id } }] },
  });
});
