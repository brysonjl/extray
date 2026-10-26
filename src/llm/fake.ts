// Deterministic in-memory LlmClient for unit tests. Zero IO, zero network.
// IMPORTANT: a FakeLlmClient test proves the HARNESS plumbs a verdict through —
// it cannot prove the real judge/normalizer resists inflation or verbosity bias.
// Those validity checks run against RECORD-captured real completions in the
// Unit 8 pilot, not here.

import type { LlmClient, LlmRequest, LlmResponse } from "./client.ts";

type FakeReply = string | Partial<LlmResponse>;
export type FakeResponder = (req: LlmRequest) => FakeReply;

function normalize(reply: FakeReply): LlmResponse {
  if (typeof reply === "string") return { text: reply, usage: { inputTokens: 0, outputTokens: 0 } };
  return { text: reply.text ?? "", usage: reply.usage ?? { inputTokens: 0, outputTokens: 0 } };
}

export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  readonly #responder: FakeResponder;

  /**
   * Construct from a function `(req) => reply`, or a record keyed by request
   * `label` (handy for a few canned call sites).
   */
  constructor(responder: FakeResponder | Record<string, FakeReply>) {
    this.#responder =
      typeof responder === "function"
        ? responder
        : (req) => {
            if (!(req.label in responder)) throw new Error(`FakeLlmClient: no canned reply for label="${req.label}"`);
            return responder[req.label]!;
          };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    return normalize(this.#responder(req));
  }
}
