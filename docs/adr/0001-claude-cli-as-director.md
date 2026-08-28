# The Director is a `claude -p` subprocess, not an API client

The handoff plan assumed an OpenAI-compatible HTTP endpoint behind a `LoungeDirector` interface. We instead shell out to the locally installed Claude Code CLI in print mode, because it needs no API key (it reuses the operator's existing Claude authentication), and `--json-schema` enforces the Reaction schema at the model boundary rather than in a parse-and-retry loop.

## Consequences

The CLI's default system prompt is expensive — measured at 15,269 cached input tokens per call. The Director must therefore always invoke with the full isolation flag set:

```
--model sonnet --tools "" --output-format json --no-session-persistence \
--disable-slash-commands --strict-mcp-config --setting-sources "" \
--system-prompt-file <director prompt> --json-schema <reaction schema>
```

Measured on a bare one-line prompt: $0.0644 with CLI defaults, $0.0301 with `--system-prompt`
alone, **$0.0042 with the full set**. Dropping any of these flags multiplies cost by up to 15x,
so the flag set is asserted in tests.

**Real calls cost more than that benchmark**, because a real Context is far larger than a
one-line prompt: measured **$0.0165–$0.0187 per pick** in production runs, so roughly **$4 for
a 238-pick draft replay** rather than $1. The flag set is still worth every bit of what it
saves — it is the difference between ~$0.017 and ~$0.08 per pick — but budget against the
higher figure. `total_cost_usd` is surfaced on every run so the real number is never a guess.

The result is read from `structured_output` in the CLI's JSON envelope. Schema enforcement at the model boundary is not a substitute for local validation: `maxItems` and `maxLength` are still checked with ajv before anything is persisted.

`--bare` looks like the natural fit for this but must not be used: it forces `ANTHROPIC_API_KEY` authentication and never reads OAuth or the keychain, which defeats the no-API-key property.

The `LoungeDirector` interface is retained so an HTTP adapter can replace the subprocess without touching the context builder.


## The `--json-schema` trap

`schemas/reaction.schema.json` declares `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
The CLI validates `--json-schema` with an ajv instance that has no draft-2020-12 meta-schema
registered, and rejects the whole thing before the model is reached:

```
Error: --json-schema is not a valid JSON Schema:
no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

`structuredOutputSchema()` strips `$schema` on the way out. It is only a dialect announcement —
every keyword in the schema is draft-07-compatible — so nothing enforced changes, and
`src/validate.ts` still validates against the committed schema with its dialect intact.

This bug made **every real Director call fail**, and no unit test caught it: the director tests
assert argv against a fake spawn, which never exercises the CLI's own schema validation. The
lesson generalizes — a mocked boundary cannot verify the contract on the other side of it, so
the flag set needs at least one real end-to-end run to be trusted.
