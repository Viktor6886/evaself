# Isolated release evals

The eval runtime is repository tooling and is never imported by production code.

```sh
node --test evals/framework.test.mjs
node evals/run.mjs fast --target internal-api --cache /tmp/eva-eval-cache
node evals/run.mjs fast --target telegram-simulator --cache /tmp/eva-eval-cache-telegram
node evals/run.mjs full --target internal-api --cache /tmp/eva-eval-cache
node evals/run.mjs fast --target internal-api --cache /tmp/eva-eval-cache --rescore
node evals/run.mjs full --target internal-api --release
node evals/run.mjs full --target telegram-simulator --release --delivery-only
```

Adapters accept an injected internal target or Telegram inbox processor, so tests execute contracts rather than stored response strings. Offline targets are safe defaults. Internal `--release` is the aggregate release gate and fails closed unless `controlled_live` and `model_judge` both execute with credentials. Telegram release is explicitly `--delivery-only` and never replaces the successful internal gate. Without release mode, live and judge are explicitly skipped non-gating lanes without credentials. Deterministic/structural checks take precedence for safety, tenancy, disclosure, delivery shape, approvals and idempotency.

Cache identity includes target, model, prompt, tool, skill and SDK versions; `--rescore` reuses outputs for rubric-only changes. Reports and cache entries are generated under `evals/reports/` and `evals/.cache/` and are not committed. Synthetic dataset validation rejects common PII and production-dialog source markers.
