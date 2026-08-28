/**
 * Local schema validation.
 *
 * The Director enforces the Reaction schema at the model boundary via
 * `--json-schema` (ADR 0001), but that is explicitly *not* a substitute for
 * validating here: `maxItems` (6 Messages) and `maxLength` (280 chars) are not
 * reliably enforced by the model boundary, so nothing is persisted or rendered
 * until it has passed through these functions.
 */
import { readFileSync } from 'node:fs';

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';

import { pickSchemaFile, playerHistorySchemaFile, reactionSchemaFile } from './paths.js';
import type { Pick, PlayerHistory, Reaction } from './types.js';

// ajv and ajv-formats are CJS with an `export default`; under NodeNext ESM the
// default import is the module object itself, so both need the standard cast.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

// `strict: false` because the handoff schemas are draft 2020-12 and use keywords
// (title, const in unions) that ajv's strict mode complains about.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function compile<T>(schemaFile: string): ValidateFunction<T> {
  const schema: unknown = JSON.parse(readFileSync(schemaFile, 'utf8'));
  return ajv.compile<T>(schema as object);
}

const pickValidator = compile<Pick>(pickSchemaFile);
const reactionValidator = compile<Reaction>(reactionSchemaFile);
const playerHistoryValidator = compile<PlayerHistory>(playerHistorySchemaFile);

/** Error carrying every ajv complaint, one per line, as `instancePath: message`. */
export class SchemaValidationError extends Error {
  readonly errors: ErrorObject[];
  readonly schemaName: string;

  constructor(schemaName: string, errors: ErrorObject[] | null | undefined) {
    const list = errors ?? [];
    super(
      `${schemaName} validation failed:\n${list
        .map((error) => `${formatInstancePath(error)}: ${error.message ?? 'invalid'}`)
        .join('\n')}`,
    );
    this.name = 'SchemaValidationError';
    this.schemaName = schemaName;
    this.errors = list;
  }
}

function formatInstancePath(error: ErrorObject): string {
  // ajv reports the document root as an empty instancePath.
  return error.instancePath === '' ? '' : error.instancePath;
}

function run<T>(
  validator: ValidateFunction<T>,
  schemaName: string,
  value: unknown,
): T {
  if (validator(value)) return value;
  throw new SchemaValidationError(schemaName, validator.errors);
}

/** Validate a normalized Pick. Throws `SchemaValidationError` listing every problem. */
export function validatePick(value: unknown): Pick {
  return run(pickValidator, 'Pick', value);
}

/** Validate a Director Reaction. Enforces <=6 Messages and <=280 chars per Message. */
export function validateReaction(value: unknown): Reaction {
  return run(reactionValidator, 'Reaction', value);
}

/** Validate one Speaker's Fantasy Memory. */
export function validatePlayerHistory(value: unknown): PlayerHistory {
  return run(playerHistoryValidator, 'PlayerHistory', value);
}

/** Non-throwing Reaction check, for retry loops that must not use exceptions for flow. */
export function isValidReaction(value: unknown): value is Reaction {
  return reactionValidator(value);
}

/** Non-throwing Pick check. */
export function isValidPick(value: unknown): value is Pick {
  return pickValidator(value);
}

/** Non-throwing Fantasy Memory check. */
export function isValidPlayerHistory(value: unknown): value is PlayerHistory {
  return playerHistoryValidator(value);
}

/** The ajv errors from the most recent `isValidReaction` call, for logging. */
export function lastReactionErrors(): ErrorObject[] {
  return reactionValidator.errors ?? [];
}
