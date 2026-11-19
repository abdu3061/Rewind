import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  fileTextRevision,
  type FileTextExtraction,
  type FileTextWrite,
  type SnapshotCapture,
} from "@rewind/contracts";
import { extractDocumentText } from "@rewind/documents";
import { FileTextIndexer } from "@rewind/engine";
import {
  docxEntries,
  pdfFixture,
  zipFixture,
} from "../../documents/src/fixtures.test-support";
import { SecureStorage } from "./secure-storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";
import { applySecureMigrations, secureMigrations } from "./migrations";
import type { DatabaseConnection, SqlValue } from "./database";

const roots: string[] = [],
  stores: SecureStorage[] = [];
beforeAll(() => vi.stubEnv("DISABLE_SYSTEM_FONTS_LOAD", "1"));
afterAll(() => vi.unstubAllEnvs());
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
const at = () => new Date().toISOString();
const available = (
  text: string,
): Extract<FileTextExtraction, { state: "available" }> => ({
  state: "available",
  format: "utf8",
  text,
  truncated: false,
  pagesRead: null,
  totalPages: null,
});
async function fixture() {
  const root = newSecureFixture(),
    file = join(root, "history.sqlite"),
    key = randomBytes(32);
  roots.push(root);
  const open = () => {
    const store = new SecureStorage(file, key);
    stores.push(store);
    return store;
  };
  const store = open();
  expect(await store.open()).toMatchObject({ ok: true });
  const sessionId = randomUUID(),
    folderId = randomUUID(),
    startedAt = new Date(Date.now() - 7 * 86400000).toISOString();
  expect(
    (
      await store.repositories.sessions.save({
        id: sessionId,
        status: "active",
        startedAt,
        updatedAt: at(),
        endedAt: null,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await store.snapshots.saveFolder({
        id: folderId,
        absolutePath: root,
        selectedAt: startedAt,
        osIdentity: "synthetic:folder",
      })
    ).ok,
  ).toBe(true);
  let serial = 0;
  async function capture(
    bytes: Uint8Array = Buffer.from("Synthetic encrypted content 87251"),
    mediaType = "text/plain",
    capturedAt = at(),
  ) {
    const fileId = randomUUID(),
      name = `synthetic-${++serial}.txt`;
    const source: SnapshotCapture = {
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
        fileId,
        sessionId,
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
      await store.snapshots.capture(
        source,
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
    return source;
  }
  const input = (
    source: SnapshotCapture,
    extraction: FileTextExtraction = available(
      Buffer.from(source.bytes).toString("utf8"),
    ),
  ): FileTextWrite => ({
    versionId: source.version.id,
    contentHash: source.version.contentHash,
    revision: fileTextRevision,
    extraction,
    indexedAt: at(),
  });
  const inspect = () => {
    const db = new NativeDatabase(file);
    db.pragma("cipher=sqlcipher");
    db.pragma("legacy=4");
    db.key(key);
    db.pragma("foreign_keys=ON");
    return db;
  };
  return {
    root,
    file,
    key,
    store,
    open,
    sessionId,
    folderId,
    capture,
    input,
    inspect,
  };
}

it("indexes real retained UTF-8/DOCX/PDF bytes through the engine and finds actual FTS hits after encrypted restart", async () => {
  const f = await fixture(),
    plain = await f.capture(
      Buffer.from("Synthetic ΩmegaContent87251 <img src=x>"),
    );
  const docx = await f.capture(
    zipFixture(
      docxEntries("<w:p><w:r><w:t>Synthetic WordBody87251</w:t></w:r></w:p>"),
    ),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const pdf = await f.capture(
    pdfFixture(["Synthetic PDFBody87251"]),
    "application/pdf",
  );
  const buffers: Uint8Array[] = [];
  const indexer = new FileTextIndexer({
    now: at,
    next: (query) => f.store.fileText.next(query),
    read: async (candidate) => {
      const read = await f.store.snapshots.read(candidate.version.id);
      if (read.ok) buffers.push(read.value.bytes);
      return read;
    },
    publish: (write, authorized) => f.store.fileText.save(write, authorized),
    authorized: () => true,
    documents: {
      busy: false,
      extract: extractDocumentText,
      stop: async () => true,
    },
  });
  expect(
    indexer.start({
      mode: "automatic",
      query: {
        through: at(),
        sessionId: f.sessionId,
        folderIds: [f.folderId],
        retryFailures: false,
      },
    }),
  ).toEqual({ ok: true, value: true });
  await indexer.settled();
  expect(indexer.state()).toMatchObject({
    busy: false,
    processed: 3,
    indexed: 3,
    unavailable: 0,
    error: null,
  });
  expect(buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
  const result = await f.store.fileText.search({
    text: "ΩmegaContent87251",
    limit: 10,
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      hasMore: false,
      hits: [
        {
          version: { id: plain.version.id },
          snippet: expect.stringContaining("<img src=x>"),
        },
      ],
    },
  });
  expect(await f.store.fileText.counts()).toEqual({
    ok: true,
    value: { eligible: 3, indexed: 3, unavailable: 0, pending: 0 },
  });
  await f.store.close();
  for (const file of readdirSync(f.root))
    expect(
      readFileSync(join(f.root, file)).includes(Buffer.from("WordBody87251")),
    ).toBe(false);
  const reopened = f.open();
  expect((await reopened.open()).ok).toBe(true);
  expect(
    await reopened.fileText.search({ text: "PDFBody87251", limit: 10 }),
  ).toMatchObject({
    ok: true,
    value: { hits: [{ format: "pdf", version: { id: pdf.version.id } }] },
  });
  const read = await reopened.snapshots.read(docx.version.id);
  expect(read.ok && Buffer.from(read.value.bytes).equals(docx.bytes)).toBe(
    true,
  );
  if (read.ok) read.value.bytes.fill(0);
});

it("removes derived rows and their FTS tokens with original expiration and ordinary deletion while Keep survives", async () => {
  const f = await fixture(),
    old = new Date(Date.now() - 80 * 3600000).toISOString();
  const expired = await f.capture(
      Buffer.from("expireText87251"),
      "text/plain",
      old,
    ),
    kept = await f.capture(Buffer.from("keptText87251"), "text/plain", old);
  for (const source of [expired, kept])
    expect((await f.store.fileText.save(f.input(source), () => true)).ok).toBe(
      true,
    );
  expect(
    (
      await f.store.repositories.checkpoints.save({
        id: randomUUID(),
        sessionId: f.sessionId,
        name: "Synthetic indexed Keep",
        createdAt: old,
        kept: true,
        fileVersionIds: [kept.version.id],
        activityIds: [],
        browserVisitIds: [],
        projectReferences: [],
      })
    ).ok,
  ).toBe(true);
  expect((await f.store.cleanup()).ok).toBe(true);
  expect(await f.store.fileText.get(expired.version.id)).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await f.store.fileText.search({ text: "expireText87251", limit: 10 }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({ text: "keptText87251", limit: 10 }),
  ).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: kept.version.id } }] },
  });
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: false })).ok,
  ).toBe(true);
  expect((await f.store.fileText.get(kept.version.id)).ok).toBe(true);
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: true })).ok,
  ).toBe(true);
  expect(
    await f.store.fileText.search({ text: "keptText87251", limit: 10 }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  await f.store.close();
  const reopened = f.open();
  expect((await reopened.open()).ok).toBe(true);
});

it("keeps unavailable extraction explicit and permits a later verified retry without overwriting successful text", async () => {
  const f = await fixture(),
    source = await f.capture();
  const failure = f.input(source, {
    state: "unavailable",
    format: "utf8",
    reason: "timeout",
  });
  expect((await f.store.fileText.save(failure, () => true)).ok).toBe(true);
  expect(await f.store.fileText.counts()).toMatchObject({
    ok: true,
    value: { indexed: 0, unavailable: 1, pending: 0 },
  });
  expect(
    await f.store.fileText.next({ through: at(), retryFailures: false }),
  ).toEqual({ ok: true, value: null });
  expect(
    await f.store.fileText.next({ through: at(), retryFailures: true }),
  ).toMatchObject({ ok: true, value: { version: { id: source.version.id } } });
  expect((await f.store.fileText.save(f.input(source), () => true)).ok).toBe(
    true,
  );
  expect(
    await f.store.fileText.save(
      f.input(source, available("must not replace")),
      () => true,
    ),
  ).toEqual({ ok: true, value: { stored: false } });
  expect(await f.store.fileText.get(source.version.id)).toMatchObject({
    ok: true,
    value: { extraction: { text: "Synthetic encrypted content 87251" } },
  });
});

it("rolls back text and FTS publication when authority is revoked before commit", async () => {
  const f = await fixture(),
    source = await f.capture(),
    authorized = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  expect(
    await f.store.fileText.save(f.input(source), authorized),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(await f.store.fileText.get(source.version.id)).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await f.store.fileText.search({ text: "encrypted", limit: 10 }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
});

it("rejects stale hashes, wrong formats, oversized text and cancelled results without writing", async () => {
  const f = await fixture(),
    source = await f.capture();
  expect(
    await f.store.fileText.save(
      { ...f.input(source), contentHash: "0".repeat(64) },
      () => true,
    ),
  ).toMatchObject({ ok: false, error: { code: "INTEGRITY_FAILURE" } });
  expect(
    await f.store.fileText.save(
      f.input(source, {
        state: "unavailable",
        format: "pdf",
        reason: "encrypted",
      }),
      () => true,
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    await f.store.fileText.save(
      f.input(source, available("😀".repeat(17000))),
      () => true,
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    await f.store.fileText.save(
      f.input(source, {
        state: "unavailable",
        format: "utf8",
        reason: "cancelled",
      }),
      () => true,
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(await f.store.fileText.counts()).toMatchObject({
    ok: true,
    value: { indexed: 0, pending: 1 },
  });
});

it.each(["original", "text"] as const)(
  "rejects tampered %s bytes before returning a hit",
  async (kind) => {
    const f = await fixture(),
      source = await f.capture();
    await f.store.fileText.save(f.input(source), () => true);
    const db = f.inspect();
    try {
      if (kind === "original") {
        db.exec("DROP TRIGGER snapshot_blob_immutable");
        db.prepare("UPDATE snapshot_blobs SET bytes=?").run(
          Buffer.alloc(source.bytes.length),
        );
      } else {
        db.exec("DROP TRIGGER file_text_source_update");
        db.prepare("UPDATE file_text SET text=?").run(
          "forged encrypted content 87251",
        );
      }
    } finally {
      db.close();
    }
    expect(await f.store.fileText.get(source.version.id)).toMatchObject({
      ok: false,
      error: { code: "INTEGRITY_FAILURE" },
    });
    expect(
      await f.store.fileText.search({ text: "encrypted", limit: 10 }),
    ).toMatchObject({ ok: false, error: { code: "INTEGRITY_FAILURE" } });
  },
);

it("bounds snippets by UTF-8 bytes and uses literal terms with session/date paging", async () => {
  const f = await fixture(),
    body = "Ω".repeat(2500) + " plainTerm87251",
    sources = [];
  for (let i = 0; i < 3; i++) {
    const source = await f.capture(Buffer.from(body));
    sources.push(source);
    await f.store.fileText.save(f.input(source), () => true);
  }
  const first = await f.store.fileText.search({
    text: "plainTerm87251",
    limit: 1,
    sessionId: f.sessionId,
  });
  expect(first).toMatchObject({
    ok: true,
    value: { hasMore: true, hits: [expect.anything()] },
  });
  if (!first.ok || !first.value.hits[0])
    throw new Error("SYNTHETIC_HIT_MISSING");
  const hit = first.value.hits[0];
  expect(Buffer.byteLength(hit.snippet)).toBeLessThanOrEqual(1000);
  expect(hit.snippet).toContain("plainTerm87251");
  expect(hit.snippet).not.toContain("[rewind-");
  expect(hit.snippet).not.toContain("�");
  expect(
    await f.store.fileText.search({
      text: "plainTerm87251",
      limit: 10,
      before: { id: hit.version.id, capturedAt: hit.version.capturedAt },
    }),
  ).toMatchObject({
    ok: true,
    value: { hits: [expect.anything(), expect.anything()], hasMore: false },
  });
  expect(
    await f.store.fileText.search({
      text: "plainTerm87251",
      limit: 10,
      sessionId: randomUUID(),
    }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({ text: '" OR * --', limit: 10 }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({
      text: Array(31).fill("word").join(" "),
      limit: 10,
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});

it("keeps candidate scans scoped and resumes equal-time work without duplicate IDs", async () => {
  const f = await fixture(),
    stamp = at(),
    a = await f.capture(Buffer.from("first"), "text/plain", stamp),
    b = await f.capture(Buffer.from("second"), "text/plain", stamp);
  const scope = {
    through: stamp,
    retryFailures: false,
    folderIds: [f.folderId],
    sessionId: f.sessionId,
  };
  const first = await f.store.fileText.next(scope);
  expect(first).toMatchObject({ ok: true, value: expect.anything() });
  if (!first.ok || !first.value) throw new Error("SYNTHETIC_CANDIDATE_MISSING");
  const next = await f.store.fileText.next({
    ...scope,
    after: { capturedAt: stamp, id: first.value.version.id },
  });
  expect(next).toMatchObject({
    ok: true,
    value: {
      version: {
        id: [a, b].find((v) => v.version.id !== first.value!.version.id)!
          .version.id,
      },
    },
  });
  expect(await f.store.fileText.next({ ...scope, folderIds: [] })).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await f.store.fileText.next({ ...scope, sessionId: randomUUID() }),
  ).toEqual({ ok: true, value: null });
});

it("withholds denied body hits before source reads and advances a bounded page cursor past them", async () => {
  const f = await fixture(),
    stamp = at();
  const sources = [
    await f.capture(
      Buffer.from("SyntheticPolicyBody42791 one"),
      "text/plain",
      stamp,
    ),
    await f.capture(
      Buffer.from("SyntheticPolicyBody42791 two"),
      "text/plain",
      stamp,
    ),
  ];
  sources.sort((a, b) => b.version.id.localeCompare(a.version.id));
  for (const source of sources)
    await f.store.fileText.save(f.input(source), () => true);
  const repository = f.store.fileText,
    read = vi.spyOn(repository, "get");
  const first = await repository.search(
    { text: "SyntheticPolicyBody42791", limit: 1 },
    (source) => source.version.id !== sources[0]!.version.id,
  );
  expect(first).toEqual({
    ok: true,
    value: {
      hits: [],
      hasMore: true,
      nextBefore: { capturedAt: stamp, id: sources[0]!.version.id },
    },
  });
  expect(read).not.toHaveBeenCalled();
  if (!first.ok) throw new Error("SYNTHETIC_PAGE_MISSING");
  expect(
    await repository.search(
      {
        text: "SyntheticPolicyBody42791",
        limit: 1,
        before: first.value.nextBefore!,
      },
      (source) => source.version.id !== sources[0]!.version.id,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      hits: [{ version: { id: sources[1]!.version.id } }],
      hasMore: false,
    },
  });
});

it("provides current bounded source identities and reports removal without returning original bytes", async () => {
  const f = await fixture(),
    source = await f.capture();
  expect(await f.store.fileText.candidate(source.version.id)).toEqual({
    ok: true,
    value: {
      version: source.version,
      displayName: source.file.displayName,
      sourceLabel:
        source.file.identity.kind === "verified-path"
          ? source.file.identity.absolutePath
          : source.file.displayName,
      folderId: f.folderId,
    },
  });
  expect(await f.store.fileText.candidate("invalid")).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: false })).ok,
  ).toBe(true);
  expect(await f.store.fileText.candidate(source.version.id)).toEqual({
    ok: true,
    value: null,
  });
});

it("refuses an index write under actual physical quota pressure and preserves original evidence", async () => {
  const f = await fixture(),
    source = await f.capture(Buffer.alloc(9 * 1024 * 1024, 71));
  await f.capture(Buffer.alloc(9 * 1024 * 1024, 72));
  expect(
    (
      await f.store.saveSettings({
        ...createDefaultSettings(),
        storageLimitBytes: 16 * 1024 * 1024,
      })
    ).ok,
  ).toBe(true);
  const usage = await f.store.usage();
  expect(usage.ok && usage.value.overQuota).toBe(true);
  expect(
    await f.store.fileText.save(
      f.input(source, available("bounded body")),
      () => true,
    ),
  ).toMatchObject({ ok: false, error: { code: "STORAGE_LIMIT" } });
  expect(await f.store.snapshots.info(source.version.id)).toMatchObject({
    ok: true,
    value: { id: source.version.id },
  });
  expect(await f.store.fileText.get(source.version.id)).toEqual({
    ok: true,
    value: null,
  });
}, 15000);

it.each(["file_text_fts_delete", "file_text_source_update"])(
  "refuses startup when required %s protection is missing",
  async (trigger) => {
    const f = await fixture(),
      source = await f.capture();
    await f.store.fileText.save(f.input(source), () => true);
    await f.store.close();
    const writer = f.inspect();
    writer.exec(`DROP TRIGGER ${trigger}`);
    writer.close();
    const reopened = f.open();
    expect((await reopened.open()).ok).toBe(false);
    expect(() => reopened.fileText).toThrow();
  },
);

it("upgrades encrypted schema nine without replacing its settings, credentials or recorded sessions", async () => {
  const root = newSecureFixture(),
    file = join(root, "history.sqlite"),
    key = randomBytes(32);
  roots.push(root);
  const writer = new NativeDatabase(file);
  writer.pragma("cipher=sqlcipher");
  writer.pragma("legacy=4");
  writer.key(key);
  const connection: DatabaseConnection = {
    exec: (sql) => writer.exec(sql),
    prepare: (sql) => writer.prepare<SqlValue[], Record<string, unknown>>(sql),
    get isTransaction() {
      return writer.inTransaction;
    },
  };
  applySecureMigrations(connection, secureMigrations.slice(0, 9));
  const settings = {
      ...createDefaultSettings(),
      excludedApplications: ["SyntheticPriorIndexSchema.exe"],
    },
    session = randomUUID(),
    time = at();
  writer
    .prepare("INSERT INTO runtime_settings VALUES(1,?)")
    .run(JSON.stringify(settings));
  writer
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run(session, "ended", time, time, time);
  writer.close();
  const store = new SecureStorage(file, key);
  stores.push(store);
  expect((await store.open()).ok).toBe(true);
  expect(await store.getSettings()).toEqual({ ok: true, value: settings });
  expect(await store.repositories.sessions.get(session)).toMatchObject({
    ok: true,
    value: { id: session },
  });
  expect(await store.fileText.counts()).toEqual({
    ok: true,
    value: { eligible: 0, indexed: 0, unavailable: 0, pending: 0 },
  });
  expect(await store.assistantCredential.read()).toMatchObject({ ok: true });
});

it("cascades indexed text and FTS during quota eviction while preserving kept original/text pairs", async () => {
  const f = await fixture(),
    kept = await f.capture(Buffer.from("SyntheticKeptBody87252"));
  expect((await f.store.fileText.save(f.input(kept), () => true)).ok).toBe(
    true,
  );
  expect(
    (
      await f.store.repositories.checkpoints.save({
        id: randomUUID(),
        sessionId: f.sessionId,
        name: "Synthetic indexed quota Keep",
        createdAt: at(),
        kept: true,
        fileVersionIds: [kept.version.id],
        activityIds: [],
        browserVisitIds: [],
        projectReferences: [],
      })
    ).ok,
  ).toBe(true);
  const bytes = Buffer.alloc(9 * 1024 * 1024, 71);
  bytes.write("SyntheticEvictedBody87252 ");
  const evicted = await f.capture(bytes);
  expect(
    (
      await f.store.fileText.save(
        f.input(evicted, {
          ...available(bytes.subarray(0, 65536).toString("utf8")),
          truncated: true,
        }),
        () => true,
      )
    ).ok,
  ).toBe(true);
  await f.capture(Buffer.alloc(9 * 1024 * 1024, 72));
  await f.store.saveSettings({
    ...createDefaultSettings(),
    storageLimitBytes: 16 * 1024 * 1024,
  });
  expect(await f.store.cleanup()).toMatchObject({
    ok: true,
    value: { overQuota: false, versionCount: 1 },
  });
  expect(
    await f.store.fileText.search({
      text: "SyntheticEvictedBody87252",
      limit: 10,
    }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({
      text: "SyntheticKeptBody87252",
      limit: 10,
    }),
  ).toMatchObject({
    ok: true,
    value: { hits: [{ version: { id: kept.version.id } }] },
  });
  await f.store.close();
  const reopened = f.open();
  expect((await reopened.open()).ok).toBe(true);
}, 20000);

it("refuses stale publication after the source was deleted and leaves no orphan text", async () => {
  const f = await fixture(),
    source = await f.capture(),
    input = f.input(source);
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: false })).ok,
  ).toBe(true);
  expect(await f.store.fileText.save(input, () => true)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.store.fileText.counts()).toEqual({
    ok: true,
    value: { eligible: 0, indexed: 0, unavailable: 0, pending: 0 },
  });
});

it("rolls back a failed text/FTS write and supports a checked retry", async () => {
  const f = await fixture(),
    source = await f.capture(),
    db = f.inspect();
  try {
    db.exec(
      "CREATE TRIGGER synthetic_index_failure BEFORE INSERT ON file_text BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INDEX_FAILURE'); END",
    );
  } finally {
    db.close();
  }
  expect(
    await f.store.fileText.save(f.input(source), () => true),
  ).toMatchObject({ ok: false });
  expect(await f.store.fileText.get(source.version.id)).toEqual({
    ok: true,
    value: null,
  });
  const repair = f.inspect();
  try {
    repair.exec("DROP TRIGGER synthetic_index_failure");
  } finally {
    repair.close();
  }
  expect(await f.store.fileText.save(f.input(source), () => true)).toEqual({
    ok: true,
    value: { stored: true },
  });
});

it("fails secure startup when the external-content FTS index no longer matches its retained text", async () => {
  const f = await fixture(),
    source = await f.capture();
  await f.store.fileText.save(f.input(source), () => true);
  await f.store.close();
  const db = f.inspect();
  try {
    const row = db.prepare("SELECT rowid,text FROM file_text").get() as {
      rowid: number;
      text: string;
    };
    db.prepare(
      "INSERT INTO file_text_fts(file_text_fts,rowid,text) VALUES('delete',?,?)",
    ).run(row.rowid, row.text);
  } finally {
    db.close();
  }
  const reopened = f.open();
  expect((await reopened.open()).ok).toBe(false);
  expect(() => reopened.fileText).toThrow();
});

it("checks source time/session and ordered date bounds without exposing arbitrary FTS syntax", async () => {
  const f = await fixture(),
    source = await f.capture();
  await f.store.fileText.save(f.input(source), () => true);
  expect(
    await f.store.fileText.search({
      text: "Synthetic",
      limit: 10,
      from: new Date(Date.now() + 10000).toISOString(),
    }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({
      text: "Synthetic",
      limit: 10,
      to: new Date(Date.now() - 10000).toISOString(),
    }),
  ).toEqual({ ok: true, value: { hits: [], hasMore: false } });
  expect(
    await f.store.fileText.search({
      text: "Synthetic",
      limit: 10,
      from: "2026-11-20T00:00:00.000Z",
      to: "2026-11-19T00:00:00.000Z",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    await f.store.fileText.next({
      through: new Date(Date.now() - 10000).toISOString(),
      retryFailures: false,
    }),
  ).toEqual({ ok: true, value: null });
});
