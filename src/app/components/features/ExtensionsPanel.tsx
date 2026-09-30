'use client';

/**
 * The Extensions panel: install, enable, disable, reload and uninstall Lua
 * extensions, and see what each one asked permission to do.
 *
 * Permission display is deliberately prominent. A sandboxed extension is only
 * trustworthy if the user can see the blast radius they granted, so the
 * permissions list is shown on the row rather than hidden behind a details
 * pane — and an extension that failed to load shows its host-side error
 * verbatim instead of a generic "failed".
 */

import React, { useCallback, useState } from 'react';
import { Icon } from '../Icon';
import type { ExtensionRecord } from '../../features/extensions/bridge';
import type { ExtensionsState } from '../../features/extensions/useExtensions';

interface ExtensionsPanelProps {
  host: ExtensionsState;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Supplied by the IDE shell; resolves a native folder/file picker. */
  onPickFolder: () => Promise<string | null>;
  onPickZip: () => Promise<string | null>;
}

const PERMISSION_HELP: Record<string, string> = {
  'fs:read': 'read files in the open workspace',
  'fs:write': 'create and overwrite files in the open workspace',
  'network:http': 'make outbound HTTP requests',
  'process:exec': 'run programs on your machine',
  'ui:notification': 'show notification toasts',
  'ui:sidebar': 'add a panel to the left sidebar',
  'ui:statusbar': 'add items to the status bar',
  'workspace:read': 'read the workspace root path',
  'clipboard:read': 'read the clipboard',
  'clipboard:write': 'write to the clipboard',
};

export default function ExtensionsPanel({
  host,
  onToast,
  onPickFolder,
  onPickZip,
}: ExtensionsPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [showInstall, setShowInstall] = useState(false);

  /** Run an action, surfacing any failure as a toast. */
  const guard = useCallback(
    async (key: string, action: () => Promise<unknown>, success?: string) => {
      setBusy(key);
      try {
        await action();
        if (success) onToast(success, 'success');
      } catch (e) {
        onToast(String(e instanceof Error ? e.message : e), 'error');
      } finally {
        setBusy(null);
      }
    },
    [onToast],
  );

  const pickFolder = async (dev: boolean) => {
    const path = await onPickFolder();
    if (!path) return;
    await guard('install', () => host.installFolder(path, dev), `Installed ${dev ? 'for development' : ''}`);
  };

  const pickZip = async () => {
    const path = await onPickZip();
    if (!path) return;
    await guard('install', () => host.installZip(path), 'Installed from archive');
  };

  const installGit = async () => {
    const url = gitUrl.trim();
    if (!url) return;
    await guard('install', () => host.installGit(url, gitRef.trim() || undefined), 'Installed from repository');
    setGitUrl('');
    setGitRef('');
  };

  if (host.loading) {
    return <div className="p-4 text-xs text-ide-faint">Loading extensions…</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader
        count={host.extensions.length}
        onToggleInstall={() => setShowInstall((v) => !v)}
        onRefresh={() => guard('refresh', () => host.refresh())}
        busy={busy}
      />

      {host.error && (
        <div className="mx-3 mt-2 px-2 py-1.5 rounded text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 break-words">
          {host.error}
        </div>
      )}

      {showInstall && (
        <InstallSection
          gitUrl={gitUrl}
          gitRef={gitRef}
          busy={busy === 'install'}
          onGitUrl={setGitUrl}
          onGitRef={setGitRef}
          onPickFolder={() => pickFolder(false)}
          onPickDev={() => pickFolder(true)}
          onPickZip={pickZip}
          onInstallGit={installGit}
        />
      )}

      <div className="flex-1 overflow-y-auto ide-scrollbar">
        {host.extensions.length === 0 ? (
          <EmptyState onBrowse={() => setShowInstall(true)} />
        ) : (
          host.extensions.map((record) => (
            <ExtensionRow
              key={record.id}
              record={record}
              busy={busy}
              onToggle={(enabled) => guard(record.id, () => host.setEnabled(record.id, enabled))}
              onReload={() => guard(record.id, () => host.reload(record.id), `Reloaded ${record.id}`)}
              onOpenFolder={() => guard(record.id, () => host.openFolder(record.id))}
              onUninstall={() => guard(record.id, () => host.uninstall(record.id), `Uninstalled ${record.id}`)}
            />
          ))
        )}
      </div>

      {host.root && (
        <div className="px-3 py-1.5 border-t border-ide-border text-[9px] text-ide-faint truncate" title={host.root}>
          {host.root}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function PanelHeader({
  count,
  onToggleInstall,
  onRefresh,
  busy,
}: {
  count: number;
  onToggleInstall: () => void;
  onRefresh: () => void;
  busy: string | null;
}) {
  return (
    <div className="px-3 py-2 flex items-center gap-2 border-b border-ide-border">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ide-muted">
        Extensions{count > 0 ? ` (${count})` : ''}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={onRefresh}
          disabled={busy === 'refresh'}
          title="Reload the extension list"
          className="px-1.5 py-0.5 text-ide-faint hover:text-ide-fg hover:bg-ide-hover rounded disabled:opacity-40"
        >
          <Icon name="rotate-cw" size={12} />
        </button>
        <button
          onClick={onToggleInstall}
          title="Import & load extensions"
          className="px-1.5 py-0.5 text-ide-faint hover:text-ide-fg hover:bg-ide-hover rounded"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function InstallSection({
  gitUrl,
  gitRef,
  busy,
  onGitUrl,
  onGitRef,
  onPickFolder,
  onPickDev,
  onPickZip,
  onInstallGit,
}: {
  gitUrl: string;
  gitRef: string;
  busy: boolean;
  onGitUrl: (v: string) => void;
  onGitRef: (v: string) => void;
  onPickFolder: () => void;
  onPickDev: () => void;
  onPickZip: () => void;
  onInstallGit: () => void;
}) {
  return (
    <div className="p-2 border-b border-ide-border space-y-1.5 bg-ide-raised/40">
      <InstallButton
        icon="folder-open"
        label="Import from Local Folder"
        hint="A folder containing extension.json"
        disabled={busy}
        onClick={onPickFolder}
      />
      <InstallButton
        icon="box"
        label="Import as Development (hot reload)"
        hint="Watches .lua files and reloads on save"
        disabled={busy}
        onClick={onPickDev}
      />
      <InstallButton
        icon="file-code"
        label="Import from ZIP Archive"
        hint="Extracts into the extensions directory"
        disabled={busy}
        onClick={onPickZip}
      />

      <div className="pt-1">
        <div className="text-[10px] text-ide-muted mb-1">Import from Git Repository</div>
        <input
          value={gitUrl}
          onChange={(e) => onGitUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onInstallGit()}
          placeholder="https://github.com/you/your-extension"
          spellCheck={false}
          className="w-full bg-ide-bg border border-ide-border rounded px-2 py-1 text-[11px] text-ide-fg outline-none focus:border-ide-accent"
        />
        <div className="flex gap-1 mt-1">
          <input
            value={gitRef}
            onChange={(e) => onGitRef(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onInstallGit()}
            placeholder="branch or tag (optional)"
            spellCheck={false}
            className="flex-1 bg-ide-bg border border-ide-border rounded px-2 py-1 text-[11px] text-ide-fg outline-none focus:border-ide-accent"
          />
          <button
            onClick={onInstallGit}
            disabled={busy || !gitUrl.trim()}
            className="px-2 py-1 rounded bg-ide-accent text-black text-[10px] font-semibold disabled:opacity-40"
          >
            Clone
          </button>
        </div>
      </div>
    </div>
  );
}

function InstallButton({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-ide-border bg-ide-bg hover:border-ide-accent/60 hover:bg-ide-hover text-left disabled:opacity-40 transition-colors"
    >
      <Icon name={icon} size={13} className="text-ide-accent shrink-0" />
      <span className="min-w-0">
        <span className="block text-[11px] text-ide-fg truncate">{label}</span>
        <span className="block text-[9px] text-ide-faint truncate">{hint}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// One extension
// ---------------------------------------------------------------------------

function ExtensionRow({
  record,
  busy,
  onToggle,
  onReload,
  onOpenFolder,
  onUninstall,
}: {
  record: ExtensionRecord;
  busy: string | null;
  onToggle: (enabled: boolean) => void;
  onReload: () => void;
  onOpenFolder: () => void;
  onUninstall: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBusy = busy === record.id;

  return (
    <div className="border-b border-ide-border-soft">
      <div className={`flex items-start gap-2 px-3 py-2 ${isBusy ? 'opacity-60' : ''}`}>
        <button
          onClick={() => onToggle(!record.enabled)}
          disabled={isBusy}
          title={record.enabled ? 'Disable' : 'Enable'}
          aria-label={record.enabled ? `Disable ${record.id}` : `Enable ${record.id}`}
          aria-pressed={record.enabled}
          className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center transition-colors ${
            record.enabled
              ? 'bg-ide-accent border-ide-accent text-black'
              : 'border-ide-muted text-transparent hover:border-ide-fg'
          } disabled:opacity-50`}
        >
          <Icon name="check" size={9} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ide-fg truncate">{record.display_name}</span>
            <span className="text-[9px] text-ide-faint shrink-0">{record.version}</span>
            {record.source === 'dev' && (
              <span
                title="Development extension — reloads automatically on save"
                className="text-[8px] px-1 rounded bg-ide-accent/20 text-ide-accent-bright shrink-0"
              >
                DEV
              </span>
            )}
            {record.active && (
              <span
                title="activate() has run"
                className="text-[8px] px-1 rounded bg-emerald-500/20 text-emerald-400 shrink-0"
              >
                ACTIVE
              </span>
            )}
          </div>

          {record.description && (
            <p className="text-[10px] text-ide-muted mt-0.5 line-clamp-2">{record.description}</p>
          )}

          {record.error && (
            <p className="text-[10px] text-red-400 mt-1 break-words">{record.error}</p>
          )}

          <div className="flex items-center gap-2 mt-1 text-[9px] text-ide-faint">
            {record.permissions.length > 0 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="hover:text-ide-muted underline decoration-dotted"
                aria-expanded={expanded}
              >
                {record.permissions.length} permission
                {record.permissions.length === 1 ? '' : 's'}
              </button>
            )}
            {record.commands.length > 0 && <span>{record.commands.length} commands</span>}
            {record.panels.length > 0 && <span>{record.panels.length} panels</span>}
            {record.author && <span className="truncate">{record.author}</span>}
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <RowAction icon="rotate-cw" label="Reload" onClick={onReload} disabled={isBusy} />
          <RowAction icon="folder" label="Open folder" onClick={onOpenFolder} disabled={isBusy} />
          <RowAction icon="trash" label="Uninstall" onClick={onUninstall} disabled={isBusy} danger />
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-2 pl-8 space-y-1">
          {record.permissions.map((permission) => (
            <div key={permission} className="flex items-start gap-1.5 text-[10px]">
              <Icon name="warning" size={10} className="text-amber-400 mt-0.5 shrink-0" />
              <span className="text-ide-fg">{permission}</span>
              <span className="text-ide-faint">
                {PERMISSION_HELP[permission] ?? 'granted by this extension'}
              </span>
            </div>
          ))}
          {record.activation_events.length > 0 && (
            <div className="text-[10px] text-ide-faint pt-1">
              Activates on: {record.activation_events.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`p-1 rounded hover:bg-ide-hover disabled:opacity-40 ${
        danger ? 'text-ide-faint hover:text-red-400' : 'text-ide-faint hover:text-ide-fg'
      }`}
    >
      <Icon name={icon} size={12} />
    </button>
  );
}

function EmptyState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="p-4 text-center">
      <p className="text-[11px] text-ide-muted">No extensions installed.</p>
      <p className="text-[10px] text-ide-faint mt-1 mb-3">
        Scaffold one with <code className="text-ide-accent">agamizcode extension init my-extension</code>
      </p>
      <button
        onClick={onBrowse}
        className="px-3 py-1 rounded bg-ide-accent text-black text-[10px] font-semibold hover:bg-ide-accent-bright"
      >
        Import &amp; Load Extensions
      </button>
    </div>
  );
}
