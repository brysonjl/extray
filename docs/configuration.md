# LLM configuration

[Back to documentation](./README.md) · [Quick Start](../README.md#quick-start)

Static scans and the Explorer synthetic demo need no provider configuration.
Live assessments send evidence and source excerpts to your configured endpoint.

## Choose an endpoint

Any **OpenAI-compatible endpoint** works: base URL plus API key. Ollama, OpenAI, and NVIDIA NIM presets are included. For another service or a local server,
provide its compatible base URL and model ID. Model support for tool calls and
structured responses matters, especially for pi; evaluate your configuration
before relying on it.

```bash
cp .env.example .env     # then fill in ONE of the blocks in it
npm run assess -- --dir ./corpus/demo-cookie-manager/extension
```

| You have | Set |
|---|---|
| An Ollama Cloud key | `OLLAMA_API_KEY=…` |
| An OpenAI key | `OPENAI_API_KEY=…` |
| An NVIDIA API Catalog key | `EXTRAY_LLM_PROVIDER=nvidia`, `NVIDIA_API_KEY=…` |
| Any other endpoint | `EXTRAY_LLM_PROVIDER=openai-compatible`, `OPENAI_BASE_URL=https://…/v1`, `OPENAI_API_KEY=…` (key optional for a local server) |

Per-run overrides: `--provider ollama|openai|nvidia|openai-compatible`,
`--base-url <url>`, `--model <id>`. The same values drive every arm.

### NVIDIA NIM

Create a key at [build.nvidia.com](https://build.nvidia.com/) and choose a model
with an available **Free Endpoint**. Add this to `.env`:

```dotenv
EXTRAY_LLM_PROVIDER=nvidia
NVIDIA_API_KEY=nvapi-your-key
# Replace with the exact model ID from the model page's API example:
SCORECARD_MODEL=YOUR_NIM_MODEL_ID
```

Then run an assessment with that model:

```bash
npm run assess -- --dir /path/to/extension --provider nvidia --model YOUR_NIM_MODEL_ID
```

The preset uses `https://integrate.api.nvidia.com/v1`; `nim` and `nvidia-nim`
are aliases for `nvidia`. In Explorer **Settings**, select **NVIDIA NIM**, enter
the same model ID and API key, and leave the base URL blank. `NVIDIA_API_KEY`
alone also selects NVIDIA when no other provider credentials or saved settings
take precedence. Use `--provider nvidia` explicitly when switching providers.

Use NVIDIA's exact model IDs, such as
[`nvidia/nemotron-3.5-lightning-30b-a3b`](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b), rather than Ollama names ending in
`:cloud`. This is a catalog example, not a model evaluated for ExtRay. Any
explicit verifier, judge, or Pi shard models must also be available on that
endpoint. Model availability changes; check the current catalog.

Choose a model that supports streaming function calls for the default `pi`
methodology, and JSON-schema structured output for verification and the shared
analysis passes. NIM models do not all support the same features. Pi uses
`max_tokens` and omits optional OpenAI storage, strict-tool, and streaming-usage
fields for NVIDIA compatibility. If a stream omits usage, Pi's token accounting
can be incomplete. Its current model registration uses a 128,000-token context
window and an 8,192-token output cap; it does not discover model limits from
NVIDIA. The generic adapter does not forward `--think` as a NVIDIA reasoning
setting. Evaluate the chosen model on the corpus before relying on its verdicts.

NVIDIA describes hosted free access as an evaluation/prototyping service;
rate limits vary by model and load. Existing retry and runner cooldown handling
applies, but there is no guaranteed fixed free quota. ExtRay does not assume
every NVIDIA endpoint costs zero; cost estimates remain unknown for unpriced
model IDs. See the [NVIDIA FAQ](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317)
and [hosted API reference](https://docs.api.nvidia.com/nim/reference/llm-apis).

`NVIDIA_BASE_URL` can point this preset at another NIM deployment. For a
self-hosted endpoint without authentication, use `--provider openai-compatible`
and its base URL instead. A `--base-url` or `EXTRAY_LLM_BASE_URL` override away
from NVIDIA's default does not inherit `NVIDIA_API_KEY`; supply the intended
endpoint's key with `EXTRAY_LLM_API_KEY` or deliberately pair `NVIDIA_BASE_URL`
with `NVIDIA_API_KEY`.

## Model choice and evaluation

Model choice affects tool use, source coverage, and the reliability of findings.
The CLI maintains compatibility/measurement hints for configured model IDs; a
hint is not a current provider catalog or an accuracy guarantee. Confirm that
an endpoint supports the selected method and test its actual outputs before
relying on a favorable verdict.

The public fixture set reproduces one monolith configuration over the synthetic
corpus. It does not rank Pi models or establish performance on store extensions.
See [evaluation](./evaluation.md) for the exact offline configuration and how to
capture a separate baseline when models or prompts change.

## Token usage and cost estimates

Token usage depends on source size, investigation depth, model behavior, and
stopping conditions. `assess` prints token and cost estimates before model calls
and records actual reported usage afterward. A configured token rate is an
estimate input, not a provider billing receipt; review the provider's current
pricing and your account limits separately. Unpriced models retain unknown cost.

`--max-tokens <n>` checks the preflight estimate and limits calls through the
shared LLM client. Pi generation uses its own SDK, so this is not a complete
spending cap on a Pi investigation. Use provider-side limits as well, and inspect
usage and incomplete outcomes when comparing methods on the same sample.

## Pi containment and prompt injection

The caveat below is the exact text the CLI prints in `--help` and the Explorer
shows next to every control that can start a `pi` run
(`src/methodologies/pi/caveat.ts` is the single source).

> The pi arm analyzes attacker-controlled extension source. Its read-only file tools
> are confined to the extension directory, including symlink checks, and automatic
> loading of AGENTS.md, CLAUDE.md, and pi configuration/resources is disabled.
> Prompt injection remains possible: instructions embedded in source can still
> influence findings. Source-grounded verification checks those claims, but a pi
> verdict is evidence to check, never an authority. Pi runs in-process with NO process
> sandbox or network egress isolation. Container execution is planned but NOT shipped;
> provide that isolation yourself for at-scale or adversarial work. The static `scan`
> path never runs an agent and is not affected.

---

## Saved settings

The Explorer stores settings in `.extray/settings.json` (gitignored, mode 0600).
`assess` reads that file too. Explicit CLI flags take precedence; model selection
can also come from `SCORECARD_MODEL` and reasoning effort from `SCORECARD_THINK`.
See `.env.example` for environment variables and `npm run assess -- --help` for
the complete flag list. The API loads `.env` from its working directory; exported
variables win. Set `SKIP_DOTENV=1` to disable loading.
