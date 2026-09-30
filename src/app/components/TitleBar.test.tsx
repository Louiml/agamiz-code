/**
 * @vitest-environment jsdom
 *
 * The title bar is the app's only window chrome - the window is created with
 * `decorations: false` - so what it says is the only place the opened workspace
 * is named.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TitleBar from './TitleBar';

describe('TitleBar', () => {
  it('always names the app', () => {
    render(<TitleBar />);
    expect(screen.getByText('Agamiz Code')).toBeTruthy();
  });

  it('shows the workspace folder name', () => {
    render(<TitleBar workspacePath="/home/u/projects/agamiz-code" />);
    expect(screen.getByText('agamiz-code')).toBeTruthy();
  });

  it('shows a Windows workspace name too', () => {
    render(<TitleBar workspacePath="C:\\work\\my-app" />);
    expect(screen.getByText('my-app')).toBeTruthy();
  });

  it('shows the bare folder name, not the path, for D:\\agamiztest', () => {
    // The exact case reported as broken: the bar must read `agamiztest`, never
    // the drive and path, because the path is already on hover.
    const { container } = render(<TitleBar workspacePath="D:\\agamiztest" />);
    expect(screen.getByText('agamiztest')).toBeTruthy();
    expect(container.textContent).not.toContain('D:\\');
  });

  it('shows no name when no workspace is open', () => {
    // The welcome screen renders the bar with no prop, and there is nothing to
    // name. A stray separator or an empty label would look like a bug.
    render(<TitleBar />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('—');
  });

  it('shows no name for a filesystem root with no name of its own', () => {
    render(<TitleBar workspacePath="/" />);
    expect(document.body.textContent ?? '').not.toContain('—');
  });

  it('keeps the full path available on hover', () => {
    // The name is what fits in the bar; the path is one hover away.
    render(<TitleBar workspacePath="/home/u/projects/agamiz-code" />);
    expect(screen.getByTitle('/home/u/projects/agamiz-code')).toBeTruthy();
  });

  it('truncates a long name rather than pushing the window controls off', () => {
    const long = `a-very-long-folder-name-that-will-not-fit-${'x'.repeat(80)}`;
    render(<TitleBar workspacePath={`/home/u/${long}`} />);
    const el = screen.getByText(long);
    expect(el.className).toContain('truncate');
  });
});
