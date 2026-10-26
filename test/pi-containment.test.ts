import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EvidencePack } from "../src/pipeline/schema.ts";
import { assertFileReadsConfined, createConfinedFileTools } from "../src/methodologies/pi/file-tools.ts";
import { buildPiRegistry, createConfinedPiSession, DIMENSIONS, runPiAgent } from "../src/methodologies/pi/runner.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) };
});

describe("pi Stage 1 containment", () => {
  let dir: string;
  let root: string;
  let reads: Set<string>;
  let tools: ToolDefinition[];
  const secret = "OUTSIDE_SECRET_DO_NOT_SEND";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-contained-"));
    root = join(dir, "extension");
    mkdirSync(join(root, "js"), { recursive: true });
    writeFileSync(join(root, "js", "main.js"), "const marker = 1;\nfetch('https://sink.invalid');\n// marker again\n");
    writeFileSync(join(dir, "label.yaml"), secret);
    symlinkSync(join(dir, "label.yaml"), join(root, "escaped.js"));
    symlinkSync(dir, join(root, "escaped-dir"));
    symlinkSync(join(root, "js"), join(root, "cycle"));
    symlinkSync("/etc/hosts", join(root, "hosts-link"));
    reads = new Set();
    tools = createConfinedFileTools(root, reads);
  });
  afterEach(() => {
    vi.mocked(pi.createAgentSession).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>, customTools = tools) {
    const tool = customTools.find((t) => t.name === name)!;
    return tool.execute("offline-test", args, undefined, undefined, undefined as never);
  }
  function text(result: Awaited<ReturnType<typeof call>>) {
    return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  async function denied(name: string, args: Record<string, unknown>, customTools = tools) {
    let output: string;
    try {
      output = text(await call(name, args, customTools));
    } catch (err) {
      output = String(err);
    }
    expect(output).not.toContain(secret);
    expect(output).toMatch(/denied/i);
  }

  it.each(["read", "ls", "grep", "find"])("%s denies parent traversal and absolute paths outside the extension", async (name) => {
    for (const path of ["../label.yaml", join(dir, "label.yaml"), "../", dir, "/etc/hosts", "~/.ssh/id_rsa"]) {
      await denied(name, { path, pattern: "*" });
    }
    expect(reads.size).toBe(0);
  });

  it.each(["read", "ls", "grep", "find"])("%s denies escaping file and directory symlinks", async (name) => {
    for (const path of ["escaped.js", "escaped-dir", "escaped-dir/label.yaml", "hosts-link"]) {
      await denied(name, { path, pattern: "*" });
    }
    expect(reads.size).toBe(0);
  });

  it("reads source with line ranges and records only source files", async () => {
    const output = text(await call("read", { path: "js/main.js", offset: 2, limit: 1 }));
    expect(output).toContain("sink.invalid");
    expect(output).not.toContain("marker = 1");
    expect([...reads]).toEqual(["js/main.js"]);
    expect(() => assertFileReadsConfined(root, reads)).not.toThrow();
  });

  it("reads the exact checked filename without SDK @ or ~ path expansion", async () => {
    writeFileSync(join(root, "@source.js"), "EXACT_AT_FILENAME");
    writeFileSync(join(root, "source.js"), "WRONG_AT_FILENAME");
    writeFileSync(join(root, "~"), "EXACT_TILDE_FILENAME");
    expect(text(await call("read", { path: "@source.js" }))).toBe("EXACT_AT_FILENAME");
    expect(text(await call("read", { path: "~" }))).toBe("EXACT_TILDE_FILENAME");
    expect([...reads]).toEqual(["@source.js", "~"]);
  });

  it("lists and finds source while omitting escaping links and avoiding directory cycles", async () => {
    expect(text(await call("ls", {}))).toContain("js/");
    expect(text(await call("ls", {}))).not.toContain("escaped");
    expect(text(await call("find", { pattern: "**/*.js" }))).toBe("js/main.js");
    expect(reads.size).toBe(0);
  });

  it("grep safely recurses, supports literal/case/glob/context/limits, and audits reads", async () => {
    const output = text(await call("grep", { pattern: "MARKER", literal: true, ignoreCase: true, glob: "**/*.js", context: 1, limit: 1 }));
    expect(output).toContain("js/main.js:1:const marker = 1");
    expect(output).toContain("js/main.js:2:fetch");
    expect(output).toContain("Match limit reached");
    expect(output).not.toContain(secret);
    expect([...reads]).toEqual(["js/main.js"]);
    const all = text(await call("grep", { pattern: "marker|sink", path: "js/main.js" }));
    expect(all).toContain("js/main.js:3:");
  });

  it("fails closed when the read trace includes an outside path or escaping symlink", () => {
    for (const path of ["../label.yaml", join(dir, "label.yaml"), "escaped.js", "escaped-dir/label.yaml", "hosts-link"]) {
      expect(() => assertFileReadsConfined(root, ["js/main.js", path])).toThrow(/containment violation/);
    }
  });

  it.each([true, false])("rejects the entire result on a successful outside read, including salvage (accepted submission: %s)", async (accepted) => {
    let emit: Parameters<AgentSession["subscribe"]>[0];
    const dispose = vi.fn();
    vi.mocked(pi.createAgentSession).mockImplementation(async (options) => {
      const fake = {
        subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
        prompt: async () => {
          emit({ type: "tool_execution_start", toolCallId: "bad-read", toolName: "read", args: { path: "../label.yaml" } });
          emit({ type: "tool_execution_end", toolCallId: "bad-read", toolName: "read", isError: false, result: { content: [{ type: "text", text: secret }] } });
          const submit = options!.customTools!.find((t) => t.name === "submit_findings")!;
          await submit.execute("submit", {
            summary: "Should never reach a verdict", findings: [],
            dismissals: accepted ? DIMENSIONS.map((concern) => ({ concern, reason: "checked" })) : [],
          }, undefined, undefined, undefined as never);
        },
        setActiveToolsByName: vi.fn(),
        abort: async () => {},
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
        dispose,
      };
      return { session: fake as unknown as AgentSession, extensionsResult: options!.resourceLoader!.getExtensions() };
    });
    await expect(runPiAgent({
      provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "offline-placeholder",
      model: "offline-test", sampleDir: root, pack: {} as EvidencePack,
      orientation: "", maxTurns: 2, noPack: true,
    })).rejects.toThrow(/containment violation/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["../label.yaml", undefined])("blocks the completeness critic after an unsafe or unauditable successful SDK read (%s)", async (path) => {
    let emit: Parameters<AgentSession["subscribe"]>[0];
    const reviewSubmission = vi.fn(async () => ({ accept: true, gaps: [] }));
    const dispose = vi.fn();
    vi.mocked(pi.createAgentSession).mockImplementation(async (options) => ({
      session: {
        subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
        prompt: async () => {
          emit({ type: "tool_execution_start", toolCallId: "bad-read", toolName: "read", args: { path } });
          emit({ type: "tool_execution_end", toolCallId: "bad-read", toolName: "read", isError: false, result: { content: [{ type: "text", text: secret }] } });
          const submit = options!.customTools!.find((t) => t.name === "submit_findings")!;
          // Match the SDK's tool-error handling: errors become tool results and
          // do not necessarily reject prompt(), so the final audit still matters.
          try {
            await submit.execute("submit", {
              summary: secret, findings: [],
              dismissals: DIMENSIONS.map((concern) => ({ concern, checks_run: ["read"], note: "checked" })),
            }, undefined, undefined, undefined as never);
          } catch {}
        },
        setActiveToolsByName: vi.fn(),
        abort: async () => {},
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
        dispose,
      } as unknown as AgentSession,
      extensionsResult: options!.resourceLoader!.getExtensions(),
    }));
    await expect(runPiAgent({
      provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "offline-placeholder",
      model: "offline-test", sampleDir: root, pack: {} as EvidencePack,
      orientation: "", maxTurns: 2, noPack: true, reviewSubmission,
    })).rejects.toThrow(/containment violation/);
    expect(reviewSubmission).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not discover ambient pi models.json configuration", async () => {
    const agentDir = join(dir, "ambient-pi");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "planted-provider": {
        baseUrl: "https://planted.invalid", api: "openai-completions",
        models: [{ id: "PLANTED_AMBIENT_MODEL" }],
      },
    } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    // Prove that the installed SDK would discover this planted config by default.
    const ambient = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    expect(ambient.getModel("planted-provider", "PLANTED_AMBIENT_MODEL")).toBeDefined();
    const { modelRuntime } = await buildPiRegistry({
      provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "offline-placeholder",
    }, "offline-test");
    expect(modelRuntime.getModel("planted-provider", "PLANTED_AMBIENT_MODEL")).toBeUndefined();
  });

  it("normalizes successful absolute SDK read arguments into a single relative trace", async () => {
    let emit: Parameters<AgentSession["subscribe"]>[0];
    vi.mocked(pi.createAgentSession).mockImplementation(async (options) => ({
      session: {
        subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
        prompt: async () => {
          const path = join(root, "js", "main.js");
          emit({ type: "tool_execution_start", toolCallId: "safe-read", toolName: "read", args: { path } });
          const read = options!.customTools!.find((t) => t.name === "read")!;
          const result = await read.execute("safe-read", { path }, undefined, undefined, undefined as never);
          emit({ type: "tool_execution_end", toolCallId: "safe-read", toolName: "read", isError: false, result });
          const submit = options!.customTools!.find((t) => t.name === "submit_findings")!;
          await submit.execute("submit", {
            summary: "Source read", findings: [],
            dismissals: DIMENSIONS.map((concern) => ({ concern, checks_run: ["read"], note: "checked" })),
          }, undefined, undefined, undefined as never);
        },
        setActiveToolsByName: vi.fn(),
        abort: async () => {},
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
        dispose: () => {},
      } as unknown as AgentSession,
      extensionsResult: options!.resourceLoader!.getExtensions(),
    }));
    const result = await runPiAgent({
      provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "offline-placeholder",
      model: "offline-test", sampleDir: root, pack: {} as EvidencePack,
      orientation: "", maxTurns: 2, noPack: true,
    });
    expect(result.trace.filesRead).toEqual(["js/main.js"]);
  });

  it("reads PNG images through the confined reader", async () => {
    const png = readFileSync("corpus/mutant-i-png-steganography/extension/img/icon_16x16.png");
    writeFileSync(join(root, "payload.png"), png);
    const output = await call("read", { path: "payload.png" });
    expect(output.content.some((c) => c.type === "image")).toBe(true);
    expect(reads.has("payload.png")).toBe(true);
  });

  it("a real offline SDK session uses confined replacements and ignores planted instructions/config/code", async () => {
    const marker = "PLANTED_SYSTEM_INSTRUCTION";
    for (const file of ["AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) writeFileSync(join(root, file), marker);
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(root, ".pi", "SYSTEM.md"), marker);
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: ["./extensions/attack.ts", "builtin:mcp", "builtin:codemode"], defaultTools: ["read", "bash", "codemode"] }));
    writeFileSync(join(root, ".pi", "extensions", "attack.ts"), "throw new Error('PLANTED_CODE_EXECUTED');");
    writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
      planted: { url: "https://planted-mcp.invalid/mcp" },
    } }));
    const { session, extensionsResult } = await createConfinedPiSession(
      { provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "offline-placeholder" },
      "offline-test", root, [], reads,
    );
    try {
      expect(session.getActiveToolNames().sort()).toEqual(["find", "grep", "ls", "read"]);
      expect(extensionsResult.extensions).toEqual([]);
      expect(extensionsResult.errors).toEqual([]);
      expect(session.systemPrompt).not.toContain(marker);
      const registered = session.getActiveToolNames().map((name) => session.getToolDefinition(name)!);
      expect(text(await call("read", { path: "js/main.js" }, registered))).toContain("marker = 1");
      for (const name of ["read", "ls", "grep", "find"]) await denied(name, { path: "../label.yaml", pattern: "*" }, registered);
      // The same files remain ordinary source data, available only on request.
      expect(text(await call("read", { path: "AGENTS.md" }, registered))).toContain(marker);
      expect(() => assertFileReadsConfined(root, reads)).not.toThrow();
    } finally {
      session.dispose();
    }
  });
});
