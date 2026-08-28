import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { outputDir } from '../../paths.js';
import { defaultOutputPath, safeFileStem } from '../index.js';

describe('safeFileStem', () => {
  it('flattens the eventId separators', () => {
    expect(safeFileStem('1234567890:31:4046')).toBe('1234567890-31-4046');
  });

  it('strips characters a filesystem would object to', () => {
    expect(safeFileStem('a/b\\c:d e?f')).toBe('a-b-c-d-e-f');
  });

  it('cannot produce a path traversal', () => {
    const stem = safeFileStem('../../etc/passwd');
    expect(stem).not.toContain('/');
    expect(stem.startsWith('.')).toBe(false);
  });

  it('never returns an empty stem', () => {
    expect(safeFileStem('   ')).toBe('reaction');
    expect(safeFileStem(':::')).toBe('reaction');
  });

  it('leaves already-safe names alone', () => {
    expect(safeFileStem('sim9001-31-4046')).toBe('sim9001-31-4046');
  });
});

describe('defaultOutputPath', () => {
  it.each(['png', 'gif', 'mp4'] as const)('lands in output/ with the %s extension', (format) => {
    expect(defaultOutputPath('1234:31:4046', format)).toBe(
      path.join(outputDir, `1234-31-4046.${format}`),
    );
  });
});
