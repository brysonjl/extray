// Exercise the real Node launcher in a fresh cwd. No provider requests or
// analyses run: the child forbids fetch and the parent only reads loopback API.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVE = fileURLToPath(new URL("../scripts/serve.ts", import.meta.url));
const PROVIDER = new URL("../src/llm/provider.ts", import.meta.url).href;
const TSX = createRequire(import.meta.url).resolve("tsx");
const FILE_KEY = "serve-env-test-file-key";
const SHELL_KEY = "serve-env-test-shell-key";
const FILE_PROFILE = JSON.stringify({ pinned: { methodology: "monolith", model: "dotenv-model" } });
const FILE_ENV = [
  "EXTRAY_LLM_PROVIDER=openai-compatible",
  "OPENAI_BASE_URL=https://provider.example/v1",
  `OPENAI_API_KEY=${FILE_KEY}`,
  "SCORECARD_MODEL=dotenv-model",
  `EXPLORER_PROFILE='${FILE_PROFILE}'`,
].join("\n");

interface Probe {
  provider: string;
  baseUrl: string;
  model: string | null;
  keyConfigured: boolean;
  keyMatchesExpected: boolean;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback test port");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function withServe(
  opts: { dotenv?: string; env?: NodeJS.ProcessEnv; expectedKey?: string },
  check: (p: { probe: Probe; settings: Record<string, unknown>; logs: string }) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "extray-serve-env-"));
  const cwd = join(root, "launch");
  mkdirSync(cwd);
  // A parent .env must never be discovered when the launch cwd has none.
  writeFileSync(join(root, ".env"), FILE_ENV);
  if (opts.dotenv !== undefined) writeFileSync(join(cwd, ".env"), opts.dotenv);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  for (const key of Object.keys(env)) {
    if (/^(EXTRAY_|EXPLORER_|SCORECARD_|OLLAMA_|OPENAI_|NVIDIA_|SKIP_DOTENV$|LLM_|NODE_OPTIONS$)/.test(key)) delete env[key];
  }
  Object.assign(env, opts.env, {
    EXTRAY_SETTINGS_PATH: join(cwd, ".extray", "settings.json"),
    TEST_EXPECTED_KEY: opts.expectedKey,
  });

  let child: ReturnType<typeof spawn> | undefined;
  try {
    const port = await availablePort();
    const code = `
      globalThis.fetch = () => { throw new Error("serve startup must not call a provider"); };
      process.argv = [process.execPath, ${JSON.stringify(SERVE)}, "--db", ${JSON.stringify(join(cwd, "test.sqlite"))}, "--port", "${port}"];
      await import(${JSON.stringify(new URL("../scripts/serve.ts", import.meta.url).href)});
      const { resolveProvider } = await import(${JSON.stringify(PROVIDER)});
      const p = resolveProvider();
      console.log("ENV_PROBE " + JSON.stringify({ provider:p.id, baseUrl:p.baseUrl,
        model:process.env.SCORECARD_MODEL ?? null, keyConfigured:Boolean(p.apiKey),
        keyMatchesExpected:p.apiKey === process.env.TEST_EXPECTED_KEY }));
    `;
    child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", code], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let logs = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not become ready: ${logs}`)), 10_000);
      const collect = (chunk: Buffer) => {
        logs += chunk.toString();
        if (logs.includes(`http://127.0.0.1:${port}/api`) && logs.includes("ENV_PROBE ")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child!.stdout!.on("data", collect);
      child!.stderr!.on("data", collect);
      child!.once("error", (err) => { clearTimeout(timer); reject(err); });
      void exited.then(
        () => { clearTimeout(timer); reject(new Error(`serve exited before readiness: ${logs}`)); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
    try {
      await ready;
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: AbortSignal.timeout(3_000) });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(FILE_KEY);
      expect(text).not.toContain(SHELL_KEY);
      expect(logs).not.toContain(FILE_KEY);
      expect(logs).not.toContain(SHELL_KEY);
      const marker = logs.split("\n").find((line) => line.startsWith("ENV_PROBE "))!;
      check({ probe: JSON.parse(marker.slice("ENV_PROBE ".length)), settings: JSON.parse(text), logs });
    } finally {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
      await exited;
      clearTimeout(timer);
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

describe("serve cwd .env", () => {
  it("loads the NVIDIA preset from .env without exposing its key", async () => {
    await withServe({ dotenv: `NVIDIA_API_KEY=${FILE_KEY}\nSCORECARD_MODEL=nvidia/test-model`, expectedKey: FILE_KEY }, ({ probe, settings }) => {
      expect(probe).toEqual({ provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/test-model", keyConfigured: true, keyMatchesExpected: true });
      expect(settings.apiKeyFromEnv).toBe(true);
      expect(settings.apiKeySet).toBe(false);
    });
  });

  it("loads provider/model/key before consumers run and keeps the key off the API and logs", async () => {
    await withServe({ dotenv: FILE_ENV, expectedKey: FILE_KEY }, ({ probe, settings, logs }) => {
      expect(probe).toEqual({ provider: "openai-compatible", baseUrl: "https://provider.example/v1", model: "dotenv-model", keyConfigured: true, keyMatchesExpected: true });
      expect(settings.apiKeyFromEnv).toBe(true);
      expect(settings.apiKeySet).toBe(false);
      expect(settings.provider).not.toHaveProperty("apiKey");
      expect(logs).toContain("Pinned pipeline: monolith · dotenv-model");
    });
  });

  it("preserves exported environment precedence over .env values", async () => {
    const profile = JSON.stringify({ pinned: { methodology: "dag", model: "shell-model" } });
    await withServe({ dotenv: FILE_ENV, expectedKey: SHELL_KEY, env: {
      EXTRAY_LLM_PROVIDER: "openai", OPENAI_API_KEY: SHELL_KEY,
      OPENAI_BASE_URL: "https://api.openai.com/v1", SCORECARD_MODEL: "shell-model", EXPLORER_PROFILE: profile,
    } }, ({ probe, settings, logs }) => {
      expect(probe).toEqual({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "shell-model", keyConfigured: true, keyMatchesExpected: true });
      expect(settings.apiKeyFromEnv).toBe(true);
      expect(logs).toContain("Pinned pipeline: dag · shell-model");
    });
  });

  it("starts without a cwd .env and never searches the parent directory", async () => {
    await withServe({}, ({ probe, settings }) => {
      expect(probe.provider).toBe("ollama");
      expect(probe.model).toBeNull();
      expect(probe.keyConfigured).toBe(false);
      expect(settings.apiKeyFromEnv).toBe(false);
    });
  });

  it("withholds a .env preset key when an exported override redirects its endpoint", async () => {
    await withServe({ dotenv: `${FILE_ENV}\nOLLAMA_API_KEY=${FILE_KEY}`, env: {
      EXTRAY_LLM_PROVIDER: "ollama", EXTRAY_LLM_BASE_URL: "https://other-provider.example/v1",
    } }, ({ probe, settings }) => {
      expect(probe.provider).toBe("ollama");
      expect(probe.baseUrl).toBe("https://other-provider.example/v1");
      expect(probe.keyConfigured).toBe(false);
      expect(settings.apiKeyFromEnv).toBe(true);
    });
  });

  it("respects SKIP_DOTENV even when a cwd file exists", async () => {
    await withServe({ dotenv: FILE_ENV, env: { SKIP_DOTENV: "1" } }, ({ probe, settings }) => {
      expect(probe.provider).toBe("ollama");
      expect(probe.model).toBeNull();
      expect(probe.keyConfigured).toBe(false);
      expect(settings.apiKeyFromEnv).toBe(false);
    });
  });
});
