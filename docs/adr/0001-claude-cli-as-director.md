# The Director is a `claude -p` subprocess, not an API client

The handoff plan assumed an OpenAI-compatible HTTP endpoint behind a `LoungeDirector` interface. We instead shell out to the locally installed Claude Code CLI in print mode, because it needs no API key (it reuses the operator's existing Claude authentication), and `--json-schema` enforces the Reaction schema at the model boundary rather than in a parse-and-retry loop.

## Consequences

The Director must always invoke with the full isolation flag set:

```
--model sonnet --tools "" --output-format json --no-session-persistence \
--disable-slash-commands --strict-mcp-config --setting-sources "" \
--system-prompt-file <director prompt> --json-schema <reaction schema>
```

These flags are what make the Director a closed box, and the flag set is asserted in tests:

- `--tools ""` — the Director cannot read or write the filesystem and cannot reach the network. Its only input is the Context we hand it in argv.
- `--setting-sources ""`, `--disable-slash-commands`, `--strict-mcp-config` — the operator's personal settings, skills, hooks, output styles and MCP servers cannot leak into the prompt or the generated dialogue.
- `--no-session-persistence` — a 238-pick replay does not litter the operator's session history.
- `--system-prompt-file` — the behavioural contract in `prompts/director.system.md` is the whole system prompt, not an addendum to the CLI's default one.
- `--output-format json` — the result is read from `structured_output` in a machine-readable envelope rather than scraped out of prose.

A Director whose output depends on whose machine it ran on is not reproducible: the same Pick and the same Context must produce the same kind of scene for every operator and in CI. Dropping any one of these flags quietly reintroduces that dependency, which is why they are checked against the argv a fake spawn sees rather than left to convention.

The result is read from `structured_output` in the CLI's JSON envelope. Schema enforcement at the model boundary is not a substitute for local validation: `maxItems` and `maxLength` are still checked with ajv before anything is persisted.

`--bare` looks like the natural fit for this but must not be used: it forces `ANTHROPIC_API_KEY` authentication and never reads OAuth or the keychain, which defeats the no-API-key property the whole design rests on.

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
