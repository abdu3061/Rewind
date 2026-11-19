import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  failure,
  fileTextIndexStateSchema,
  fileTextWriteSchema,
  type DocumentProcessor,
  type DocumentText,
  type FileTextCandidate,
  type FileTextCandidateQuery,
  type FileTextIndexState,
  type FileTextRunScope,
  type FileTextWrite,
  type FileVersion,
  type Result,
} from "@rewind/contracts";
import { FileTextIndexer } from "./file-text-indexer";

const capturedAt = "2026-11-19T12:00:00.000Z",
  through = "2026-11-19T12:00:01.000Z";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(0);
const finish = async (indexer: FileTextIndexer) => {
  const settled = indexer.settled();
  await vi.runAllTimersAsync();
  await settled;
};
function setup() {
  const sessionId = randomUUID(),
    folderId = randomUUID();
  const sources: { candidate: FileTextCandidate; bytes: Uint8Array }[] = [],
    buffers: Uint8Array[] = [];
  const writes: FileTextWrite[] = [],
    states: FileTextIndexState[] = [];
  const excluded = new Set<string>();
  let available = true,
    recording = true,
    previewBusy = false;
  const add = (
    bytes = Buffer.from("Synthetic captured body 98137"),
    mediaType = "text/plain",
  ) => {
    const candidate: FileTextCandidate = {
      version: {
        id: randomUUID(),
        fileId: randomUUID(),
        sessionId,
        capturedAt,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
        mediaType,
      },
      displayName: "synthetic.txt",
      sourceLabel: "C:\\Synthetic\\synthetic.txt",
      folderId,
    };
    sources.push({ candidate, bytes: Uint8Array.from(bytes) });
    sources.sort((a, b) =>
      a.candidate.version.id.localeCompare(b.candidate.version.id),
    );
    return candidate;
  };
  const next = vi.fn(
    async (
      query: FileTextCandidateQuery,
    ): Promise<Result<FileTextCandidate | null>> => ({
      ok: true,
      value:
        sources.find(
          ({ candidate: { version } }) =>
            (!query.after || version.id > query.after.id) &&
            !writes.some((w) => w.versionId === version.id),
        )?.candidate ?? null,
    }),
  );
  const read = vi.fn(
    async (
      candidate: FileTextCandidate,
    ): Promise<Result<{ version: FileVersion; bytes: Uint8Array }>> => {
      const source = sources.find(
        (s) => s.candidate.version.id === candidate.version.id,
      )!;
      const bytes = Uint8Array.from(source.bytes);
      buffers.push(bytes);
      return { ok: true, value: { version: { ...candidate.version }, bytes } };
    },
  );
  const publish = vi.fn(
    async (
      write: FileTextWrite,
      authorized: () => boolean,
    ): Promise<Result<{ stored: boolean }>> => {
      if (!authorized())
        return failure("FORBIDDEN", "Synthetic revoked authority.");
      writes.push(fileTextWriteSchema.parse(write));
      return { ok: true, value: { stored: true } };
    },
  );
  const extract = vi.fn<DocumentProcessor["extract"]>(
    async (format): Promise<DocumentText> => ({
      state: "available",
      format,
      text: "Synthetic parsed body 98137",
      truncated: false,
      pagesRead: format === "pdf" ? 1 : null,
      totalPages: format === "pdf" ? 1 : null,
    }),
  );
  const stop = vi.fn<DocumentProcessor["stop"]>(async () => true);
  const documents: DocumentProcessor = {
    get busy() {
      return previewBusy;
    },
    extract,
    stop,
  };
  const authorized = vi.fn(
    (scope: FileTextRunScope, candidate?: FileTextCandidate) =>
      available &&
      (scope.mode === "saved" || recording) &&
      (!candidate || !excluded.has(candidate.version.id)),
  );
  const onChanged = vi.fn((state: FileTextIndexState) => {
    states.push(fileTextIndexStateSchema.parse(state));
  });
  const indexer = new FileTextIndexer({
    now: () => through,
    next,
    read,
    publish,
    documents,
    authorized,
    onChanged,
  });
  const scope: FileTextRunScope = {
    mode: "automatic",
    query: { through, retryFailures: false, sessionId, folderIds: [folderId] },
  };
  return {
    indexer,
    add,
    sources,
    buffers,
    writes,
    states,
    next,
    read,
    publish,
    extract,
    stop,
    authorized,
    onChanged,
    excluded,
    scope,
    revoke: () => {
      available = false;
    },
    pause: () => {
      recording = false;
    },
    busy: () => {
      previewBusy = true;
    },
  };
}

it("indexes bounded retained UTF-8 sources one at a time, advances equal-time cursors and wipes owned buffers", async () => {
  const s = setup();
  s.add();
  s.add();
  expect(s.indexer.start(s.scope)).toEqual({ ok: true, value: true });
  expect(s.indexer.state().busy).toBe(true);
  expect(s.indexer.start(s.scope)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  await finish(s.indexer);
  expect(s.writes).toHaveLength(2);
  expect(s.writes[0]!.extraction).toMatchObject({
    state: "available",
    text: "Synthetic captured body 98137",
  });
  expect(s.next.mock.calls[1]![0].after).toEqual({
    capturedAt,
    id: s.writes[0]!.versionId,
  });
  expect(s.indexer.state()).toMatchObject({
    busy: false,
    processed: 2,
    indexed: 2,
    unavailable: 0,
    error: null,
  });
  expect(s.buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
  expect(Buffer.from(s.sources[0]!.bytes).toString()).toContain(
    "Synthetic captured",
  );
});
it("denies automatic work without current recording authority and rejects unscoped or retrying automatic work", () => {
  const s = setup();
  s.pause();
  expect(s.indexer.start(s.scope)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  for (const query of [
    { through, retryFailures: false },
    { ...s.scope.query, retryFailures: true },
  ])
    expect(
      s.indexer.start({ mode: "automatic", query } as FileTextRunScope),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(s.read).not.toHaveBeenCalled();
});
it("allows separately admitted saved-history work while recording is paused", async () => {
  const s = setup();
  s.add();
  s.pause();
  expect(
    s.indexer.start({ mode: "saved", query: { through, retryFailures: true } })
      .ok,
  ).toBe(true);
  await finish(s.indexer);
  expect(s.writes).toHaveLength(1);
  expect(s.next.mock.calls[0]![0].retryFailures).toBe(true);
});
it("skips excluded candidates without reading their bodies", async () => {
  const s = setup(),
    source = s.add();
  s.excluded.add(source.version.id);
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.read).not.toHaveBeenCalled();
  expect(s.writes).toHaveLength(0);
});
it("revocation while a retained read is queued prevents extraction and publication", async () => {
  const s = setup(),
    candidate = s.add(Buffer.from("synthetic pdf"), "application/pdf");
  const read = deferred<Awaited<ReturnType<typeof s.read>>>();
  s.read.mockReturnValueOnce(read.promise);
  s.indexer.start(s.scope);
  await tick();
  s.pause();
  const bytes = Uint8Array.from(s.sources[0]!.bytes);
  read.resolve({ ok: true, value: { version: candidate.version, bytes } });
  await finish(s.indexer);
  expect(s.extract).not.toHaveBeenCalled();
  expect(s.publish).not.toHaveBeenCalled();
  expect(bytes.every((value) => value === 0)).toBe(true);
});
it("stop confirms its owner without waiting on the coordinator read it could otherwise deadlock", async () => {
  const s = setup(),
    candidate = s.add(),
    read = deferred<Awaited<ReturnType<typeof s.read>>>();
  s.read.mockReturnValueOnce(read.promise);
  s.indexer.start(s.scope);
  await tick();
  expect(await s.indexer.stop()).toBe(true);
  expect(s.stop.mock.calls[0]![0]?.aborted).toBe(true);
  expect(s.indexer.state().busy).toBe(true);
  read.resolve({
    ok: true,
    value: {
      version: candidate.version,
      bytes: Uint8Array.from(s.sources[0]!.bytes),
    },
  });
  await finish(s.indexer);
  expect(s.publish).not.toHaveBeenCalled();
  expect(s.indexer.state().busy).toBe(false);
});
it("retains actual pending parser work after cancellation until its promise settles", async () => {
  const s = setup();
  s.add(Buffer.from("synthetic pdf"), "application/pdf");
  const parsed = deferred<DocumentText>();
  s.extract.mockReturnValueOnce(parsed.promise);
  s.indexer.start(s.scope);
  await tick();
  expect(await s.indexer.stop()).toBe(true);
  expect(s.indexer.start(s.scope)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  parsed.resolve({
    state: "available",
    format: "pdf",
    text: "stale body",
    truncated: false,
    pagesRead: 1,
    totalPages: 1,
  });
  await finish(s.indexer);
  expect(s.writes).toHaveLength(0);
  expect(s.buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
});
it("continues past a source removed before reading without publishing an orphan", async () => {
  const s = setup();
  s.add();
  s.add();
  s.read.mockResolvedValueOnce(
    failure("NOT_FOUND", "Synthetic expired source."),
  );
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.writes).toHaveLength(1);
  expect(s.indexer.state().error).toBeNull();
});
it.each(["bytes", "metadata"] as const)(
  "refuses changed source %s before parser admission",
  async (mode) => {
    const s = setup(),
      candidate = s.add(Buffer.from("synthetic pdf"), "application/pdf");
    const bytes = Uint8Array.from(s.sources[0]!.bytes);
    const version = { ...candidate.version };
    if (mode === "bytes") bytes[0] = 0;
    else version.capturedAt = through;
    s.read.mockResolvedValueOnce({ ok: true, value: { version, bytes } });
    s.indexer.start(s.scope);
    await finish(s.indexer);
    expect(s.indexer.state().error?.code).toBe("INTEGRITY_FAILURE");
    expect(s.extract).not.toHaveBeenCalled();
    expect(s.publish).not.toHaveBeenCalled();
    expect(bytes.every((value) => value === 0)).toBe(true);
  },
);
it.each(["session", "folder", "future", "cursor"] as const)(
  "refuses a candidate outside its %s scope",
  async (mode) => {
    const s = setup(),
      candidate = s.add();
    if (mode === "session") candidate.version.sessionId = randomUUID();
    if (mode === "folder") candidate.folderId = randomUUID();
    if (mode === "future")
      candidate.version.capturedAt = "2026-11-19T13:00:00.000Z";
    if (mode === "cursor")
      s.next.mockResolvedValue({ ok: true, value: candidate });
    s.indexer.start(s.scope);
    await finish(s.indexer);
    expect(s.indexer.state().error?.code).toBe("INTEGRITY_FAILURE");
    expect(s.writes).toHaveLength(mode === "cursor" ? 1 : 0);
  },
);
it("persists invalid UTF-8 as unavailable without fabricating text", async () => {
  const s = setup();
  s.add(Buffer.from([0xff, 0xfe, 0x61]));
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.writes[0]!.extraction).toEqual({
    state: "unavailable",
    format: "utf8",
    reason: "malformed",
  });
  expect(s.indexer.state()).toMatchObject({
    processed: 1,
    indexed: 0,
    unavailable: 1,
  });
});
it("clips UTF-8 on complete code points within the byte bound", async () => {
  const s = setup();
  s.add(Buffer.from("x".repeat(65535) + "😀more"));
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.writes[0]!.extraction).toMatchObject({
    state: "available",
    text: "x".repeat(65535),
    truncated: true,
  });
});
it.each(["format", "oversize", "page count"] as const)(
  "refuses a parser's invalid %s result",
  async (mode) => {
    const s = setup();
    s.add(Buffer.from("synthetic pdf"), "application/pdf");
    s.extract.mockResolvedValueOnce({
      state: "available",
      format: mode === "format" ? "docx" : "pdf",
      text: mode === "oversize" ? "x".repeat(65537) : "synthetic body",
      truncated: false,
      pagesRead: mode === "page count" ? 2 : 1,
      totalPages: 1,
    });
    s.indexer.start(s.scope);
    await finish(s.indexer);
    expect(s.writes[0]!.extraction).toEqual({
      state: "unavailable",
      format: "pdf",
      reason: "unavailable",
    });
    expect(s.stop.mock.calls[0]![0]).toBe(s.extract.mock.calls[0]![2]);
  },
);
it("never persists a cancelled extraction as a durable failure", async () => {
  const s = setup();
  s.add(Buffer.from("synthetic pdf"), "application/pdf");
  s.extract.mockResolvedValueOnce({
    state: "unavailable",
    format: "pdf",
    reason: "cancelled",
  });
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.publish).not.toHaveBeenCalled();
});
it.each(["false", "exception"] as const)(
  "keeps an unconfirmed parser busy after stop returns %s",
  async (mode) => {
    const s = setup();
    s.add(Buffer.from("synthetic pdf"), "application/pdf");
    if (mode === "false") s.stop.mockResolvedValue(false);
    else s.stop.mockRejectedValue(new Error("SYNTHETIC_CLOSE_FAILED"));
    s.indexer.start(s.scope);
    await finish(s.indexer);
    expect(s.indexer.state()).toMatchObject({
      busy: true,
      error: { code: "UNAVAILABLE" },
    });
    expect(s.writes).toHaveLength(0);
    expect(s.indexer.start(s.scope)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    s.stop.mockResolvedValue(true);
    expect(await s.indexer.stop()).toBe(true);
    expect(s.indexer.state().busy).toBe(false);
  },
);
it("yields to an active preview without recording a permanent extraction failure", async () => {
  const s = setup();
  s.add(Buffer.from("synthetic pdf"), "application/pdf");
  s.busy();
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.extract).not.toHaveBeenCalled();
  expect(s.publish).not.toHaveBeenCalled();
  expect(s.indexer.state()).toMatchObject({
    busy: false,
    error: { code: "CONFLICT" },
  });
});
it("stops on quota refusal and leaves the remaining sources pending", async () => {
  const s = setup();
  s.add();
  s.add();
  s.publish.mockResolvedValueOnce(
    failure("STORAGE_LIMIT", "Synthetic quota refusal."),
  );
  s.indexer.start(s.scope);
  await finish(s.indexer);
  expect(s.read).toHaveBeenCalledTimes(1);
  expect(s.indexer.state().error?.code).toBe("STORAGE_LIMIT");
});
it("revocation is checked again at the actual publication boundary", async () => {
  const s = setup();
  s.add();
  const publication = deferred<Awaited<ReturnType<typeof s.publish>>>();
  s.publish.mockImplementationOnce(async (_write, authorized) => {
    await publication.promise;
    expect(authorized()).toBe(false);
    return failure("FORBIDDEN", "Synthetic revoked before commit.");
  });
  s.indexer.start(s.scope);
  await tick();
  s.indexer.invalidate();
  publication.resolve({ ok: true, value: { stored: false } });
  await finish(s.indexer);
  expect(s.writes).toHaveLength(0);
});
it("copies admitted scope, contains observer errors and fails closed if policy throws", async () => {
  const s = setup();
  s.add();
  s.onChanged.mockImplementation(() => {
    throw new Error("SYNTHETIC_OBSERVER");
  });
  s.indexer.start(s.scope);
  s.scope.query.through = "2026-11-20T12:00:00.000Z";
  await finish(s.indexer);
  expect(s.next.mock.calls[0]![0].through).toBe(through);
  expect(s.writes).toHaveLength(1);
  s.authorized.mockImplementation(() => {
    throw new Error("SYNTHETIC_POLICY");
  });
  expect(s.indexer.start(s.scope)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});
it("close is idempotent and refuses subsequent work", async () => {
  const s = setup();
  s.add();
  s.indexer.start(s.scope);
  expect(await s.indexer.close()).toBe(true);
  expect(await s.indexer.close()).toBe(true);
  expect(s.indexer.start(s.scope)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  expect(s.publish).not.toHaveBeenCalled();
});
