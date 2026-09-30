/**
 * @vitest-environment jsdom
 *
 * The script picker is the only path from a `package.json` to the runner, so
 * these cover what it shows and what it invokes.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExecutionControls from './ExecutionControls';
import type { ExecutionState } from '../../features/execution';

const idle = { status: 'idle' } as ExecutionState;

function setup(over: Partial<Parameters<typeof ExecutionControls>[0]> = {}) {
  const props = {
    state: idle,
    configName: null,
    configCount: 0,
    rakMode: 'interp' as const,
    rakModeDisabled: true,
    onRakModeChange: () => {},
    onRun: () => {},
    onDebug: () => {},
    onStop: () => {},
    onOpenInterpreter: () => {},
    onOpenDebugConsole: () => {},
    onEditConfigurations: () => {},
    interpreterLabel: 'none',
    canRun: false,
    canDebug: false,
    scriptOptions: [] as { name: string; script: string }[],
    selectedScript: null as string | null,
    onSelectScript: () => {},
    onRunScript: () => {},
    ...over,
  };
  return { ...render(<ExecutionControls {...props} />), props };
}

describe('package.json script picker', () => {
  it('is absent when the project has no scripts', () => {
    setup();
    expect(screen.queryByTitle('Choose a package.json script to run')).toBeNull();
  });

  it('appears once scripts are discovered', () => {
    setup({ scriptOptions: [{ name: 'npm: dev', script: 'dev' }] });
    expect(screen.getByTitle('Choose a package.json script to run')).toBeTruthy();
  });

  it('shows the selected script, not the raw config name', () => {
    setup({
      scriptOptions: [{ name: 'npm: dev', script: 'dev' }],
      selectedScript: 'dev',
    });
    expect(screen.getByText('dev')).toBeTruthy();
  });

  it('says it runs the active file when nothing is selected', () => {
    setup({ scriptOptions: [{ name: 'npm: dev', script: 'dev' }] });
    expect(screen.getByText('Run active file')).toBeTruthy();
  });

  it('lists every script when opened', () => {
    setup({
      scriptOptions: [
        { name: 'npm: dev', script: 'dev' },
        { name: 'npm: build', script: 'build' },
        { name: 'npm: test', script: 'test' },
      ],
    });
    fireEvent.click(screen.getByTitle('Choose a package.json script to run'));
    expect(screen.getByText('build')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();
  });

  it('runs the script that was clicked', () => {
    const onRunScript = vi.fn();
    const onSelectScript = vi.fn();
    setup({
      scriptOptions: [{ name: 'npm: build', script: 'build' }],
      onRunScript,
      onSelectScript,
    });
    fireEvent.click(screen.getByTitle('Choose a package.json script to run'));
    fireEvent.click(screen.getByText('build'));
    expect(onRunScript).toHaveBeenCalledWith('build');
    // Selecting and running are one action: the user asked for it to run.
    expect(onSelectScript).toHaveBeenCalledWith('build');
  });

  it('can go back to running the active file', () => {
    const onSelectScript = vi.fn();
    const onRunScript = vi.fn();
    setup({
      scriptOptions: [{ name: 'npm: dev', script: 'dev' }],
      selectedScript: 'dev',
      onSelectScript,
      onRunScript,
    });
    fireEvent.click(screen.getByTitle('Choose a package.json script to run'));
    fireEvent.click(screen.getAllByText('Run active file')[0]);
    expect(onSelectScript).toHaveBeenCalledWith(null);
    // Choosing the active file must not launch a script.
    expect(onRunScript).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    setup({ scriptOptions: [{ name: 'npm: dev', script: 'dev' }] });
    fireEvent.click(screen.getByTitle('Choose a package.json script to run'));
    expect(screen.getByText('dev')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /dev/ })).toBeNull();
  });
});
