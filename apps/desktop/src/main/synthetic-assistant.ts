import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import type { AssistantCredentialChallenge } from "@rewind/contracts";

/** Explicit marked-profile tests only. Never a normal-profile credential, endpoint or transport fallback. */
const fixtureKey = "Synthetic_Rewind_Only_Gemini_16905";
export function sealSyntheticAssistantCredential(
  challenge: AssistantCredentialChallenge,
) {
  return {
    id: challenge.id,
    sealed: publicEncrypt(
      {
        key: createPublicKey({
          format: "jwk",
          key: {
            kty: "RSA",
            n: Buffer.from(challenge.modulus, "base64").toString("base64url"),
            e: "AQAB",
          },
        }),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(JSON.stringify({ id: challenge.id, apiKey: fixtureKey })),
    ).toString("base64"),
  };
}
const reply = (parts: unknown[]) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    }),
    { headers: { "content-type": "application/json" } },
  );
/** Deterministic SDK responses with no network call, URL override or executable fixture content. */
export const syntheticAssistantTransport: typeof fetch = async (
  _input,
  init,
) => {
  try {
    const body = JSON.parse(String(init?.body)) as {
      contents: { parts: { text: string }[] }[];
    };
    const request = JSON.parse(body.contents[0]!.parts[0]!.text) as {
      question: string;
      evidence?: { key: string; title: string; excerpt?: string }[];
      approvedEvidence?: { key: string; title: string }[];
    };
    if (request.question.includes("synthetic-provider-error"))
      return new Response("Synthetic provider unavailable", { status: 503 });
    if (request.question.includes("synthetic-provider-delay"))
      return await new Promise<Response>((_resolve, reject) => {
        if (!init?.signal || init.signal.aborted)
          return reject(new Error("SYNTHETIC_REQUEST_ABORTED"));
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("SYNTHETIC_REQUEST_ABORTED")),
          { once: true },
        );
      });
    const records = request.approvedEvidence ?? request.evidence;
    if (!records?.length)
      return new Response("Synthetic evidence missing", { status: 400 });
    const keys = records.slice(0, 4).map((item) => item.key);
    if (request.approvedEvidence)
      return reply([
        { functionCall: { name: "get_approved_evidence", args: { keys } } },
      ]);
    const insufficient = request.question.includes(
      "synthetic-missing-evidence",
    );
    return reply([
      {
        text: JSON.stringify({
          text: insufficient
            ? "The selected observations do not establish the requested information."
            : `Synthetic answer: ${records[0]!.title}. <img src=x onerror=alert(1)> is untrusted text.`,
          sourceKeys: insufficient ? [] : keys,
          insufficientEvidence: insufficient,
        }),
      },
    ]);
  } catch {
    return new Response("Synthetic request invalid", { status: 400 });
  }
};
