# The Director is a `claude -p` subprocess, not an API client

The handoff plan assumed an OpenAI-compatible HTTP endpoint behind a `LoungeDirector` interface. We instead shell out to the locally installed Claude Code CLI in print mode, because it needs no API key (it reuses the operator's existing Claude authentication), and `--json-schema` enforces the Reaction schema at the model boundary rather than in a parse-and-retry loop.

## Consequences

The CLI's default system prompt is expensive — measured at 15,269 cached input tokens per call. The Director must therefore always invoke with the full isolation flag set:

```
--model sonnet --tools "" --output-format json --no-session-persistence \
--disable-slash-commands --strict-mcp-config --setting-sources "" \
--system-prompt-file <director prompt> --json-schema <reaction schema>
```

Measured cost per call: $0.0644 with defaults, $0.0301 with `--system-prompt` alone, **$0.0042 with the full set** — roughly $1 for a 238-pick draft replay. Dropping any of these flags silently multiplies cost by up to 15x, so the flag set is asserted in tests.

The result is read from `structured_output` in the CLI's JSON envelope. Schema enforcement at the model boundary is not a substitute for local validation: `maxItems` and `maxLength` are still checked with ajv before anything is persisted.

`--bare` looks like the natural fit for this but must not be used: it forces `ANTHROPIC_API_KEY` authentication and never reads OAuth or the keychain, which defeats the no-API-key property.

The `LoungeDirector` interface is retained so an HTTP adapter can replace the subprocess without touching the context builder.
