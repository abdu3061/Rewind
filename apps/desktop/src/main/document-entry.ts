import {
  documentParseRequestSchema,
  type DocumentParseReply,
} from "@rewind/contracts";
import { extractDocumentText } from "@rewind/documents";

const port = process.parentPort;
if (!port) throw new Error("DOCUMENT_PARENT_REQUIRED");
if (
  !process.execArgv.includes("--disallow-code-generation-from-strings") ||
  !process.execArgv.includes("--max-old-space-size=192") ||
  process.env.DISABLE_SYSTEM_FONTS_LOAD !== "1" ||
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH ||
  process.env.NODE_OPTIONS ||
  process.env.NODE_PATH
)
  throw new Error("DOCUMENT_PROCESS_POLICY_REQUIRED");
let used = false;
const startup = setTimeout(() => process.exit(1), 10000);
port.on("message", async ({ data }: { data: unknown }) => {
  if (used) return process.exit(1);
  used = true;
  const parsed = documentParseRequestSchema.safeParse(data);
  if (!parsed.success) return process.exit(1);
  clearTimeout(startup);
  const message = parsed.data;
  try {
    const result = await extractDocumentText(message.format, message.bytes);
    const reply: DocumentParseReply = {
      version: 1,
      type: "parsed",
      id: message.id,
      result,
    };
    port.postMessage(reply);
  } finally {
    message.bytes.fill(0);
    // Parent observes actual exit before publishing the preview or admitting another job.
    process.exit(0);
  }
});
