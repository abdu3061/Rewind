import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { OperationalLog } from "./operational-log";

it("retains bounded code-only diagnostics and rotates without reading history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rewind-log-synthetic-"));
  try {
    const log = new OperationalLog(root);
    log.write("DESKTOP_STARTING");
    const record = JSON.parse(
      readFileSync(path.join(root, "operations.jsonl"), "utf8"),
    );
    expect(Object.keys(record).sort()).toEqual(["code", "time"]);
    expect(record.code).toBe("DESKTOP_STARTING");
    writeFileSync(path.join(root, "operations.jsonl"), "x".repeat(65536));
    log.write("SERVICE_UNAVAILABLE");
    expect(
      readFileSync(path.join(root, "operations.previous.jsonl"), "utf8"),
    ).toHaveLength(65536);
    expect(
      JSON.parse(readFileSync(path.join(root, "operations.jsonl"), "utf8"))
        .code,
    ).toBe("SERVICE_UNAVAILABLE");
    writeFileSync(path.join(root, "operations.jsonl"), "y".repeat(65536));
    log.write("DESKTOP_STOPPED");
    expect(
      readFileSync(path.join(root, "operations.previous.jsonl"), "utf8"),
    ).toHaveLength(65536);
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "synthetic");
    expect(() =>
      new OperationalLog(blocked).write("DESKTOP_READY"),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
