/**
 * The commander surface.
 *
 * These assertions exist because the surface is a contract with a human: the
 * README, the plan's §12 command list and `--help` all promise the same flags.
 * Nothing here executes a command — only the wiring is inspected.
 */
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { FORMATS } from '../../render/index.js';

import { buildProgram } from '../index.js';

function command(name: string): Command {
  const program = buildProgram();
  const found = program.commands.find((cmd) => cmd.name() === name);
  if (!found) throw new Error(`no '${name}' command is registered`);
  return found;
}

function flags(cmd: Command): string[] {
  return cmd.options.map((option) => option.long ?? option.short ?? '');
}

describe('command surface', () => {
  it('registers every command the plan and the README promise', () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual([
      'board',
      'demo',
      'history',
      'react',
      'screenshot',
      'setup',
      'simulate',
      'watch',
    ]);
  });

  it('registers `history import` with --league and --target', () => {
    const importCmd = command('history').commands.find((cmd) => cmd.name() === 'import');
    expect(importCmd).toBeDefined();
    expect(flags(importCmd as Command)).toEqual(
      expect.arrayContaining(['--league', '--target']),
    );
  });

  it('gives simulate every mode and pipeline flag', () => {
    expect(flags(command('simulate'))).toEqual(
      expect.arrayContaining([
        '--next',
        '--pick',
        '--all',
        '--limit',
        '--alias',
        '--no-render',
        '--format',
        '--stub',
      ]),
    );
  });

  it('gives watch --league, --interval, --once, --no-render, --format and --stub', () => {
    expect(flags(command('watch'))).toEqual(
      expect.arrayContaining(['--league', '--interval', '--once', '--no-render', '--format', '--stub']),
    );
  });

  it('gives demo --pick, --format, --no-open and --stub, and nothing mandatory', () => {
    const demo = command('demo');
    expect(flags(demo)).toEqual(expect.arrayContaining(['--pick', '--format', '--no-open', '--stub']));
    // Zero arguments must be a valid invocation — that is the whole point.
    expect(demo.registeredArguments).toHaveLength(0);
    expect(demo.options.every((option) => !option.mandatory)).toBe(true);
  });

  it('defaults demo to png, the format that renders in about three seconds', () => {
    const format = command('demo').options.find((option) => option.long === '--format');
    expect(format?.defaultValue).toBe('png');
  });

  it('defaults watch to a 25 second poll interval', () => {
    const interval = command('watch').options.find((option) => option.long === '--interval');
    expect(interval?.defaultValue).toBe(25);
  });

  it('accepts --verbose after the subcommand name, where people actually type it', () => {
    for (const name of ['demo', 'simulate', 'react', 'screenshot', 'board', 'watch', 'setup', 'history']) {
      expect(flags(command(name))).toContain('--verbose');
    }
    expect(flags(buildProgram())).toContain('--verbose');
  });

  it('offers exactly the formats the renderer can produce', () => {
    // The CLI imports FORMATS from the render layer rather than keeping its own
    // copy, so a format can never be renderable but unselectable, or the reverse.
    const format = command('react').options.find((option) => option.long === '--format');
    expect(format?.argChoices).toEqual([...FORMATS]);
    expect(format?.argChoices).toContain('html');
  });

  it('leads the help text with the command a first-time reader should run', () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain('npm run demo');
    expect(help).toContain('--stub');
  });
});
