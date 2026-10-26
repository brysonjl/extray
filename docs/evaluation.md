# Evaluation and replay

[Back to documentation](./README.md)

`eval` runs one arm over the labeled corpus and grades it against the answer
keys. It defaults to REPLAY off committed fixtures, which makes it **offline
with no API key, but only for one exact configuration**. Replay is an
exact-match lookup on model + prompt, so the committed fixtures are valid only
with exactly these flags:

```bash
npm run eval -- --methodology monolith --model glm-5.2:cloud --think high \
  --verifier-model gpt-oss:120b --judge-model minimax-m3.1-flash:cloud
# Equivalent shortcut:
npm run eval:replay
```

Generation uses GLM 5.2, claim verification uses GPT-OSS, and corpus grading
uses MiniMax M3.1 Flash. The separate judge family reduces self-grading bias;
it does not establish judge accuracy. The recordings reproduce this exact
synthetic baseline, not a validated ranking of model families.

`npm run fixtures:check` validates recording integrity, synthetic-source
provenance, and the complete replay chain. CI also runs the advertised replay
command. Unused recordings and real-extension analyses do not belong in the
public fixture directory.

Any other model, `--think` level, verifier/judge, or methodology has no
fixtures and needs a live RECORD run (needs a key, costs money):

```bash
npm run eval -- --methodology dag --runs 3 --record
npm run eval -- --model <new-model> --record
```

Writes `scorecard.json` and `scorecard.md` (coverage A–G vs H, per-arm
bellwether, unsafe misses, caveats). Both are gitignored artifacts — regenerate
rather than commit. Exit codes: `0` ok, `2` config/usage error, `4` REPLAY
fixture miss.

Re-recording fixtures after a prompt or model change is a deliberate manual step:
set a `SCORECARD_JUDGE_MODEL` (or `--judge-model`) from a **different model family** than the arm
to limit self-grading bias, run
`npm run eval -- --record`, then pass the inter-rater gate with
`npm run pilot -- --record --write` before treating the scores as final.

---

Compare approaches on the same samples using the
[methodology comparison loop](./methodology-comparison-loop.md). Review labels
and source manually as well: an automated judge is another model, and synthetic
coverage is not a measurement of real-store accuracy. See the
[ground-truth protocol](./ground-truth-protocol.md).
