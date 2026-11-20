import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  versionPreviewResponseSchema,
  type DocumentFormat,
  type DocumentText,
  type SnapshotCapture,
  type DocumentProcessor,
} from "@rewind/contracts";
import { SessionCoordinator, SessionService } from "@rewind/engine";
import { SecureStorage } from "@rewind/storage";
import { ProtectedFolderCollector } from "@rewind/collectors";
import { extractDocumentText } from "@rewind/documents";
import { FileOperations } from "./file-operations";
import { WorkerRuntime } from "./worker-runtime";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";
import {
  docxEntries,
  pdfFixture,
  zipFixture,
} from "../../../../packages/documents/src/fixtures.test-support";

const fixtures: {
  root: string;
  storage: SecureStorage;
  coordinator: SessionCoordinator;
  runtime?: WorkerRuntime;
}[] = [];
beforeAll(() => vi.stubEnv("DISABLE_SYSTEM_FONTS_LOAD", "1"));
afterAll(() => vi.unstubAllEnvs());
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime?.shutdown();
    await fixture.coordinator.shutdown();
    await fixture.storage.close();
    removeSecureFixture(fixture.root);
  }
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
};
async function fixture() {
  const root = newSecureFixture(),
    key = randomBytes(32),
    database = join(root, "history.sqlite"),
    generation = randomUUID();
  let revision = 0,
    files: FileOperations | null = null,
    now = Date.now();
  const storage = new SecureStorage(database, key, {
    evidenceChanged: (mutation) => {
      if (files?.referencesRemoved(mutation.retainsVersion)) {
        revision++;
        files.invalidatePreviews();
      }
    },
  });
  const coordinator = new SessionCoordinator({
    mode: "session-only",
    service: new SessionService({
      newId: randomUUID,
      now: () => new Date(now).toISOString(),
    }),
  });
  const entry: (typeof fixtures)[number] = { root, storage, coordinator };
  fixtures.push(entry);
  expect((await storage.open()).ok).toBe(true);
  const settings = createDefaultSettings(),
    sessionId = randomUUID(),
    folderId = randomUUID();
  const at = new Date(now).toISOString();
  const startedAt = new Date(now - 7 * 24 * 3600000).toISOString();
  expect(
    (
      await storage.repositories.sessions.save({
        id: sessionId,
        status: "active",
        startedAt,
        updatedAt: at,
        endedAt: null,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await storage.snapshots.saveFolder({
        id: folderId,
        absolutePath: root,
        osIdentity: "synthetic:folder",
        selectedAt: startedAt,
      })
    ).ok,
  ).toBe(true);
  const documents = {
    busy: false,
    extract: vi.fn<DocumentProcessor["extract"]>(
      async (format: DocumentFormat, bytes: Uint8Array) =>
        extractDocumentText(format, bytes),
    ),
    stop: vi.fn<DocumentProcessor["stop"]>(async () => {
      documents.busy = false;
      return true;
    }),
  };
  files = new FileOperations({
    storage,
    coordinator,
    documents,
    authority: () => ({ generation, revision }),
    folders: new ProtectedFolderCollector({
      getFolders: () => storage.snapshots.listFolders(),
      resolveFileId: (folder, relative) =>
        storage.snapshots.resolveFileId(folder, relative),
      getLatestVersion: async (fileId) => {
        const result = await storage.snapshots.listVersions({
          fileId,
          limit: 1,
        });
        return result.ok
          ? { ok: true, value: result.value[0] ?? null }
          : result;
      },
    }),
    root,
    synthetic: true,
    getSettings: () => settings,
    changeSettings: async () => ({ ok: true, value: undefined }),
  });
  async function capture(
    bytes = pdfFixture(["Synthetic retained PDF marker 62491"]),
    mediaType = "application/pdf",
    capturedAt = at,
    nameOverride?: string,
  ) {
    const fileId = randomUUID(),
      name =
        nameOverride ??
        (mediaType === "application/pdf" ? "synthetic.pdf" : "synthetic.docx");
    const value: SnapshotCapture = {
      file: {
        id: fileId,
        displayName: name,
        identity: {
          kind: "verified-path",
          absolutePath: join(root, name),
          verifiedAt: capturedAt,
        },
      },
      version: {
        id: randomUUID(),
        sessionId,
        fileId,
        capturedAt,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
        mediaType,
      },
      bytes: Uint8Array.from(bytes),
      binding: {
        folderId,
        relativePath: name,
        osIdentity: `synthetic:${fileId}`,
      },
    };
    expect(
      await storage.snapshots.capture(
        value,
        {
          id: randomUUID(),
          sessionId,
          occurredAt: capturedAt,
          type: "file-change",
          source: "filesystem",
          payload: { fileId, change: "captured" },
        },
        () => true,
      ),
    ).toMatchObject({ ok: true });
    return value;
  }
  const preview = (id: string, requestId = randomUUID()) =>
    files!.execute({ kind: "versions.preview", id, requestId }, () => true);
  const cancel = (requestId: string) =>
    files!.execute({ kind: "versions.cancel-preview", requestId }, () => true);
  const inspect = () => {
    const db = new NativeDatabase(database);
    db.pragma("cipher=sqlcipher");
    db.pragma("legacy=4");
    db.key(key);
    return db;
  };
  return {
    root,
    key,
    database,
    storage,
    coordinator,
    documents,
    files,
    capture,
    preview,
    cancel,
    inspect,
    generation,
    entry,
    revision: () => revision,
    time: (value: number) => {
      now = value;
    },
  };
}

it("previews actual encrypted DOCX/PDF originals as bounded derived text with current source receipts", async () => {
  const f = await fixture();
  const pdf = await f.capture(),
    word = await f.capture(
      zipFixture(
        docxEntries(
          "<w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt; Synthetic Word</w:t></w:r></w:p>",
        ),
      ),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  const portable = versionPreviewResponseSchema.parse(
      await f.preview(pdf.version.id),
    ),
    docx = versionPreviewResponseSchema.parse(await f.preview(word.version.id));
  expect(portable).toMatchObject({
    ok: true,
    value: {
      text: expect.stringContaining("Synthetic retained PDF marker 62491"),
      warning: expect.stringContaining("PDF selectable text"),
      authority: { generation: f.generation, revision: f.revision() },
    },
  });
  expect(docx).toMatchObject({
    ok: true,
    value: {
      text: "<img src=x onerror=alert(1)> Synthetic Word\n",
      warning: expect.stringContaining("DOCX body text"),
    },
  });
  const original = await f.storage.snapshots.read(pdf.version.id);
  expect(
    original.ok && Buffer.from(original.value.bytes).equals(pdf.bytes),
  ).toBe(true);
  if (original.ok) original.value.bytes.fill(0);
  expect(
    readFileSync(f.database).includes(
      Buffer.from("Synthetic retained PDF marker 62491"),
    ),
  ).toBe(false);
});
it.each(["malformed", "encrypted", "limit", "timeout", "unavailable"] as const)(
  "reports %s extraction without claiming corrupt storage or losing recoverable original bytes",
  async (reason) => {
    const f = await fixture(),
      source = await f.capture();
    f.documents.extract.mockResolvedValueOnce({
      state: "unavailable",
      format: "pdf",
      reason,
    });
    expect(await f.preview(source.version.id)).toMatchObject({
      ok: true,
      value: {
        text: null,
        warning: expect.stringContaining(
          "Original bytes remain captured and verified",
        ),
      },
    });
    const read = await f.storage.snapshots.read(source.version.id);
    expect(read.ok && read.value.version.contentHash).toBe(
      source.version.contentHash,
    );
    if (read.ok) read.value.bytes.fill(0);
  },
);
it("does not occupy the coordinator during parsing and refuses a late answer after actual history deletion", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return answer.promise;
  });
  const preview = f.preview(source.version.id);
  await entered.promise;
  expect((await f.coordinator.read(() => f.storage.usage())).ok).toBe(true);
  expect(
    (
      await f.coordinator.read(() =>
        f.storage.deleteHistory({ includeKept: false, confirmed: true }),
      )
    ).ok,
  ).toBe(true);
  expect(f.revision()).toBeGreaterThan(0);
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "must never publish",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});
it("rechecks actual retained hashes after extraction and refuses byte tampering", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return answer.promise;
  });
  const preview = f.preview(source.version.id);
  await entered.promise;
  const db = f.inspect();
  try {
    db.exec("DROP TRIGGER snapshot_blob_immutable");
    db.prepare("UPDATE snapshot_blobs SET bytes=?").run(
      Buffer.alloc(source.bytes.length),
    );
  } finally {
    db.close();
  }
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "stale untrusted result",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
});
it("cancels only the owned request and confirms the read-model lifetime before replacement", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>(),
    requestId = randomUUID();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return answer.promise;
  });
  const preview = f.preview(source.version.id, requestId);
  await entered.promise;
  const calls = f.documents.stop.mock.calls.length;
  expect(await f.cancel(randomUUID())).toEqual({ ok: true, value: true });
  expect(f.documents.stop).toHaveBeenCalledTimes(calls);
  const cancelled = f.cancel(requestId);
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "late cancelled text",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(await cancelled).toEqual({ ok: true, value: true });
  expect(await f.preview(source.version.id)).toMatchObject({
    ok: true,
    value: { text: expect.stringContaining("Synthetic retained PDF") },
  });
});
it("retains failed-close ownership after a reply and retries its stop without touching another request", async () => {
  const f = await fixture(),
    source = await f.capture(),
    requestId = randomUUID();
  f.documents.extract.mockImplementationOnce(async () => {
    f.documents.busy = true;
    return { state: "unavailable", format: "pdf", reason: "unavailable" };
  });
  await f.preview(source.version.id, requestId);
  const owner = f.documents.extract.mock.calls.at(-1)![2];
  expect(owner).toBeInstanceOf(AbortSignal);
  f.documents.stop.mockResolvedValueOnce(false);
  expect(await f.cancel(requestId)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(await f.cancel(requestId)).toEqual({ ok: true, value: true });
  expect(f.documents.stop.mock.calls.at(-1)![0]).toBe(owner);
  const calls = f.documents.stop.mock.calls.length;
  expect(await f.cancel(randomUUID())).toEqual({ ok: true, value: true });
  expect(f.documents.stop).toHaveBeenCalledTimes(calls);
});
it("uses metadata for recovery selection without invoking a document parser", async () => {
  const f = await fixture(),
    source = await f.capture();
  expect(
    await f.files.execute(
      { kind: "versions.source", id: source.version.id },
      () => true,
    ),
  ).toMatchObject({
    ok: true,
    value: { displayName: "synthetic.pdf", version: { id: source.version.id } },
  });
  expect(f.documents.extract).not.toHaveBeenCalled();
});

it("normal worker maintenance drains the parser, advances preview authority and rejects delayed text after deletion", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>();
  await f.storage.close();
  const runtime = new WorkerRuntime({
    root: f.root,
    key: Buffer.from(f.key),
    synthetic: true,
    documentProcessor: f.documents,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  });
  f.entry.runtime = runtime;
  expect((await runtime.initialize()).ok).toBe(true);
  const initial = runtime.snapshot().documentAuthority;
  f.documents.extract.mockImplementationOnce(async () => {
    f.documents.busy = true;
    entered.resolve();
    return answer.promise;
  });
  const preview = runtime.execute({
    kind: "versions.preview",
    id: source.version.id,
  });
  await entered.promise;
  expect(
    (
      await runtime.execute({
        kind: "storage.delete",
        value: { includeKept: false, confirmed: true },
      })
    ).ok,
  ).toBe(true);
  expect(runtime.snapshot().documentAuthority).toMatchObject({
    generation: initial.generation,
    revision: expect.any(Number),
  });
  expect(runtime.snapshot().documentAuthority.revision).toBeGreaterThan(
    initial.revision,
  );
  expect(f.documents.busy).toBe(false);
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "late deleted source",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(
    await runtime.execute({ kind: "versions.info", id: source.version.id }),
  ).toEqual({ ok: true, value: null });
});

it("does not delete history or acknowledge maintenance when parser closure is unconfirmed", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>();
  await f.storage.close();
  const options = {
    root: f.root,
    synthetic: true,
    documentProcessor: f.documents,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  };
  const runtime = new WorkerRuntime({ ...options, key: Buffer.from(f.key) });
  f.entry.runtime = runtime;
  expect((await runtime.initialize()).ok).toBe(true);
  f.documents.extract.mockImplementationOnce(async () => {
    f.documents.busy = true;
    entered.resolve();
    return answer.promise;
  });
  const preview = runtime.execute({
    kind: "versions.preview",
    id: source.version.id,
  });
  await entered.promise;
  f.documents.stop.mockResolvedValueOnce(false);
  expect(
    await runtime.execute({
      kind: "storage.delete",
      value: { includeKept: false, confirmed: true },
    }),
  ).toMatchObject({ ok: false });
  expect(runtime.snapshot().collection).not.toBe("active");
  const db = f.inspect();
  try {
    expect(
      (
        db.prepare("SELECT count(*) AS count FROM file_versions").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  } finally {
    db.close();
  }
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "late denied result",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect((await runtime.shutdown()).ok).toBe(true);
  const restarted = new WorkerRuntime({ ...options, key: Buffer.from(f.key) });
  f.entry.runtime = restarted;
  expect((await restarted.initialize()).ok).toBe(true);
  expect(
    await restarted.execute({ kind: "versions.info", id: source.version.id }),
  ).toMatchObject({ ok: true, value: { id: source.version.id } });
  expect(
    (
      await restarted.execute({
        kind: "storage.delete",
        value: { includeKept: false, confirmed: true },
      })
    ).ok,
  ).toBe(true);
  expect(
    await restarted.execute({ kind: "versions.info", id: source.version.id }),
  ).toEqual({ ok: true, value: null });
});

it("ordinary expiration of unrelated history does not repeatedly cancel a retained document preview", async () => {
  const f = await fixture(),
    source = await f.capture();
  const expired = await f.capture(
    pdfFixture(["Synthetic expired unrelated PDF"]),
    "application/pdf",
    new Date(Date.now() - 80 * 3600000).toISOString(),
    "expired.pdf",
  );
  const result = await f.preview(source.version.id);
  expect(result).toMatchObject({
    ok: true,
    value: { authority: { revision: 0 } },
  });
  expect(f.revision()).toBe(0);
  expect(await f.storage.snapshots.info(expired.version.id)).toEqual({
    ok: true,
    value: null,
  });
});

it("expiration of the selected source invalidates parsing before commit", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    answer = deferred<DocumentText>();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return answer.promise;
  });
  const preview = f.preview(source.version.id);
  await entered.promise;
  expect(
    (
      await f.coordinator.read(() =>
        f.storage.cleanup(new Date(Date.now() + 73 * 3600000)),
      )
    ).ok,
  ).toBe(true);
  expect(f.revision()).toBeGreaterThan(0);
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "expired text must not publish",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("kept selected versions remain previewable while automatic retention removes unrelated activity", async () => {
  const f = await fixture(),
    source = await f.capture();
  expect(
    await f.storage.repositories.checkpoints.save({
      id: randomUUID(),
      sessionId: source.version.sessionId,
      name: "Synthetic kept document",
      createdAt: new Date().toISOString(),
      kept: true,
      fileVersionIds: [source.version.id],
      activityIds: [],
      browserVisitIds: [],
      projectReferences: [],
    }),
  ).toMatchObject({ ok: true });
  const entered = deferred<void>(),
    answer = deferred<DocumentText>();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return answer.promise;
  });
  const preview = f.preview(source.version.id);
  await entered.promise;
  expect(
    (
      await f.coordinator.read(() =>
        f.storage.cleanup(new Date(Date.now() + 73 * 3600000)),
      )
    ).ok,
  ).toBe(true);
  expect(f.revision()).toBe(0);
  answer.resolve({
    state: "available",
    format: "pdf",
    text: "Synthetic retained PDF marker 62491",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await preview).toMatchObject({
    ok: true,
    value: {
      authority: { revision: 0 },
      text: "Synthetic retained PDF marker 62491",
    },
  });
});

it("replaces a pending preview only after its owned request closes and ignores its stale cancellation", async () => {
  const f = await fixture(),
    source = await f.capture(),
    entered = deferred<void>(),
    secondEntered = deferred<void>(),
    first = deferred<DocumentText>(),
    second = deferred<DocumentText>();
  f.documents.extract.mockImplementationOnce(async () => {
    entered.resolve();
    return first.promise;
  });
  f.documents.extract.mockImplementationOnce(async () => {
    secondEntered.resolve();
    return second.promise;
  });
  const firstId = randomUUID(),
    secondId = randomUUID();
  const old = f.preview(source.version.id, firstId);
  await entered.promise;
  const next = f.preview(source.version.id, secondId);
  first.resolve({
    state: "available",
    format: "pdf",
    text: "old text",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await old).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  await secondEntered.promise;
  const calls = f.documents.stop.mock.calls.length;
  expect(await f.cancel(firstId)).toEqual({ ok: true, value: true });
  expect(f.documents.stop).toHaveBeenCalledTimes(calls);
  second.resolve({
    state: "available",
    format: "pdf",
    text: "Synthetic retained PDF marker 62491",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  expect(await next).toMatchObject({
    ok: true,
    value: { text: "Synthetic retained PDF marker 62491" },
  });
});
