'use client';

/**
 * New Project wizard.
 *
 * A full-screen modal, in the spirit of JetBrains' new-project dialog: pick a
 * template, name it, choose where it goes, and see exactly what will be written
 * before anything is. Three states live here — the form, the overwrite
 * confirmation, and the in-flight creation — because a collision is a *normal*
 * outcome (re-creating a project in the same folder) and must not be a
 * `window.confirm` interrupt that loses the form.
 *
 * The wizard owns no filesystem or project state. It resolves the destination,
 * asks the host what would collide, and hands a plain
 * `CreateProjectRequest` back to the shell, which is the only place that
 * mutates the workspace.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Aliased: the component's own `open` prop would otherwise shadow the folder
// picker, and the two have nothing to do with each other.
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { Icon } from './Icon';
import { materialize, templatePreviewPaths, type ProjectTemplate, type ProjectTemplatePreviewEntry } from '../features/projectTemplates';

export interface CreateProjectRequest {
  /**
   * Already materialized with the project name, so `entryFile` and every path
   * are exactly what will be written. The shell does not substitute again.
   */
  template: ProjectTemplate;
  /** Absolute path of the folder to create. */
  root: string;
  projectName: string;
  runInstall: boolean;
  /** True once the user has confirmed a collision in this dialog. */
  overwrite: boolean;
}

export interface ProjectPathStatus {
  path: string;
  exists: boolean;
}

interface NewProjectDialogProps {
  /** Built-in plus extension-contributed templates, already merged. */
  templates: ProjectTemplate[];
  /** Where the wizard should default to — see the parent for how it is derived. */
  defaultLocation: string;
  onClose: () => void;
  /**
   * Ask the host which of a template's paths already exist under `root`. The
   * template passed in is already materialized with the project name, so a
   * template using `\${PROJECT_NAME}` in a path is checked for the path that
   * will actually be written.
   */
  inspect: (root: string, template: ProjectTemplate) => Promise<ProjectPathStatus[]>;
  onCreate: (request: CreateProjectRequest) => Promise<void>;
}

type Phase = 'form' | 'confirm-overwrite' | 'creating';

/** Characters Windows forbids in a path component, plus both separators. */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/** Reserved device names. A folder called `con` cannot be created on Windows. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Join a parent directory and a project name without doubling separators. */
function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return parent.replace(/[\\/]+$/, '') + '\\' + name;
}

/**
 * Validate a project name.
 *
 * Returns a message rather than throwing so the field can show it inline while
 * the user is still typing. Reserved names are a *warning*, not a block: the
 * host will report the real failure, and refusing here would stop a user on a
 * non-Windows build for no reason.
 */
function validateName(name: string): { error?: string; warning?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'Enter a project name.' };
  if (ILLEGAL_NAME_CHARS.test(trimmed)) {
    return { error: 'A project name cannot contain \\ / : * ? " < > or |' };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { error: 'That is not a usable folder name.' };
  }
  if (trimmed.endsWith('.')) {
    return { error: 'A folder name cannot end with a period on Windows.' };
  }
  if (RESERVED_NAMES.test(trimmed)) {
    return { warning: `"${trimmed}" is a reserved Windows device name. Creation will probably fail.` };
  }
  return {};
}

/**
 * Turn a flat path list into a tree, so the preview can nest `src/` under
 * `src/main.rs` instead of showing a flat column of unrelated-looking names.
 */
interface PreviewNode {
  name: string;
  /** Full slash-separated path from the project root. */
  path: string;
  children: PreviewNode[];
  isFile: boolean;
  /** True for paths a generator will create rather than the IDE writing them. */
  generated: boolean;
}

function buildTree(entries: ProjectTemplatePreviewEntry[]): PreviewNode[] {
  const root: PreviewNode = { name: '', path: '', children: [], isFile: false, generated: false };

  for (const { path, generated } of entries) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let next = node.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path: childPath, children: [], isFile: isLast, generated };
        node.children.push(next);
      } else if (isLast) {
        // A path can arrive as both a written file and a declared output; the
        // written one wins, because that is the one the IDE is responsible for.
        next.generated = next.generated && generated;
      }
      node = next;
    });
  }

  // Directories before files, then alphabetical — the order a file tree is
  // expected to read in.
  const sort = (nodes: PreviewNode[]): PreviewNode[] => {
    nodes.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
    nodes.forEach((n) => sort(n.children));
    return nodes;
  };
  return sort(root.children);
}

function TreeRow({ node, depth, entryFile, autoOpen }: { node: PreviewNode; depth: number; entryFile: string | null; autoOpen: boolean }) {
  const hasChildren = node.children.length > 0;
  // Directories start expanded. Templates are small (a dozen files at most), so
  // showing the whole tree costs nothing and means the entry file is visible
  // without a click; the toggle stays for the extension-contributed case, where
  // a generator template can ship something much larger.
  const [open, setOpen] = useState(autoOpen || hasChildren);
  const isEntry = entryFile === node.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasChildren && setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-ide-hover ${
          isEntry ? 'text-ide-accent-bright' : node.isFile ? 'text-ide-fg' : 'text-ide-muted'
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} className="shrink-0 text-ide-faint" />
        ) : (
          <span className="w-[10px] shrink-0" />
        )}
        <Icon name={node.isFile ? 'file-text' : 'folder'} size={11} className="shrink-0 text-ide-faint" />
        <span className="truncate">{node.name}</span>
        {isEntry ? (
          <span className="ml-auto shrink-0 text-[9px] text-ide-faint">opens on create</span>
        ) : node.generated ? (
          <span
            className="ml-auto shrink-0 text-[9px] text-ide-faint"
            title="Created by the project generator, not written by the IDE"
          >
            generated
          </span>
        ) : null}
      </button>
      {open && node.children.map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} entryFile={entryFile} autoOpen={autoOpen} />)}
    </div>
  );
}

/**
 * Mounted only while open (the parent renders `{open && <NewProjectDialog/>}`),
 * so every field starts from a fresh initialiser and there is no "reset when
 * `open` flips" effect. Re-opening after a failed creation therefore cannot
 * resurrect a half-filled form.
 */
export default function NewProjectDialog({
  templates,
  defaultLocation,
  onClose,
  inspect,
  onCreate,
}: NewProjectDialogProps) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState(defaultLocation);
  const [templateId, setTemplateId] = useState<string>('');
  const [runInstall, setRunInstall] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [collisions, setCollisions] = useState<string[]>([]);

  const nameRef = useRef<HTMLInputElement>(null);

  const templatesById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const template = templatesById.get(templateId) ?? templates[0] ?? null;
  const activeTemplateId = template?.id ?? '';

  /**
   * Derived rather than stored: a template with nothing to install must not
   * carry a stale `true` left over from the previously selected one, and
   * clearing the flag in an effect is exactly the cascading-render pattern
   * `useState` initialisers avoid.
   */
  const installRunnable = !!template?.installCommand;
  const wantsInstall = runInstall && installRunnable;

  // Autofocus after paint, so the input exists and the caret lands correctly.
  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const nameCheck = validateName(name);
  const root = name.trim() ? joinPath(location, name.trim()) : '';

  /**
   * The preview list: written files plus declared generator outputs. Uses the
   * preview helper rather than `files` alone so a `createCommand` template shows
   * the files the generator will actually create.
   */
  const preview = useMemo(() => (template ? templatePreviewPaths(template) : []), [template]);
  const tree = useMemo(() => buildTree(preview), [preview]);

  /** Folders on the entry file's path, so the preview opens them for free. */
  const entryDirs = useMemo(() => {
    if (!template?.entryFile) return new Set<string>();
    const parts = template.entryFile.split('/');
    const set = new Set<string>();
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    return set;
  }, [template]);

  const chooseLocation = useCallback(async () => {
    try {
      const selected = await openFolderDialog({ directory: true, multiple: false, title: 'Choose a parent folder' });
      if (typeof selected === 'string' && selected) setLocation(selected);
    } catch {
      setError('Could not open the folder picker.');
    }
  }, []);

  const submit = useCallback(
    async (overwrite: boolean) => {
      if (!template) return;
      if (nameCheck.error) {
        setError(nameCheck.error);
        nameRef.current?.focus();
        return;
      }
      if (!root) {
        setError('Choose a location for the project.');
        return;
      }

      setPhase('creating');
      setError(null);
      try {
        // Materialize once, up front: inspection and creation must agree on the
        // exact paths, and a template that names the project in a path would
        // otherwise be checked and written differently.
        const resolved = materialize(template, name.trim());
        // A template can legitimately ship zero files and rely on a
        // `createCommand` alone, so an empty inspection is not an error and must
        // not be treated as "nothing to check".
        const statuses = await inspect(root, resolved);
        const clashing = statuses.filter((s) => s.exists).map((s) => s.path);
        if (clashing.length > 0 && !overwrite) {
          setCollisions(clashing);
          setPhase('confirm-overwrite');
          return;
        }
        await onCreate({
          template: resolved,
          root,
          projectName: name.trim(),
          runInstall: wantsInstall,
          overwrite,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('form');
      }
    },
    [template, nameCheck.error, root, inspect, onCreate, name, wantsInstall],
  );

  // Escape closes, but never mid-creation — cancelling then would leave files
  // on disk with no UI acknowledging them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'creating') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const busy = phase === 'creating';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Project"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-ide-border bg-ide-bg shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ide-border-soft px-5 py-3">
          <h2 className="text-sm font-semibold text-ide-fg">New Project</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-ide-faint hover:text-ide-fg disabled:opacity-40"
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {templates.length === 0 ? (
            <p className="py-10 text-center text-xs text-ide-faint">No project templates are available.</p>
          ) : (
            <>
              <section aria-label="Template">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ide-faint">Template</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {templates.map((t) => {
                    const selected = t.id === activeTemplateId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTemplateId(t.id)}
                        disabled={busy}
                        className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
                          selected
                            ? 'border-ide-accent bg-ide-accent/10'
                            : 'border-ide-border-soft hover:border-ide-accent/50 hover:bg-ide-hover'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Icon name={t.icon} size={15} className={selected ? 'text-ide-accent-bright' : 'text-ide-muted'} />
                          <span className="text-xs font-medium text-ide-fg">{t.name}</span>
                          {t.source !== 'builtin' && (
                            <span className="ml-auto rounded bg-ide-raised px-1 py-0.5 text-[9px] text-ide-faint">ext</span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-[10px] leading-relaxed text-ide-muted">{t.description}</span>
                        {t.tags.length > 0 && (
                          <span className="mt-auto flex flex-wrap gap-1 pt-1">
                            {t.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="rounded bg-ide-raised px-1.5 py-0.5 text-[9px] text-ide-faint">
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section aria-label="Destination" className="mt-5 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ide-faint">Name</span>
                  <input
                    ref={nameRef}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) void submit(false);
                    }}
                    placeholder="my-project"
                    spellCheck={false}
                    className={`w-full rounded-md border bg-ide-raised px-2.5 py-1.5 text-xs text-ide-fg outline-none placeholder:text-ide-faint ${
                      nameCheck.error ? 'border-red-500/70' : 'border-ide-border-soft focus:border-ide-accent'
                    }`}
                  />
                  {nameCheck.error ? (
                    <span className="mt-1 block text-[10px] text-red-400">{nameCheck.error}</span>
                  ) : nameCheck.warning ? (
                    <span className="mt-1 block text-[10px] text-amber-400">{nameCheck.warning}</span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ide-faint">Location</span>
                  <span className="flex gap-1.5">
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-md border border-ide-border-soft bg-ide-raised px-2.5 py-1.5 text-xs text-ide-fg outline-none focus:border-ide-accent"
                    />
                    <button
                      type="button"
                      onClick={() => void chooseLocation()}
                      disabled={busy}
                      title="Browse for a parent folder"
                      className="shrink-0 rounded-md border border-ide-border-soft bg-ide-raised px-2 text-ide-muted hover:border-ide-accent/50 hover:text-ide-fg disabled:opacity-40"
                    >
                      <Icon name="folder-search" size={14} />
                    </button>
                  </span>
                </label>
              </section>

              {root && !nameCheck.error && (
                <p className="mt-2 truncate text-[10px] text-ide-faint" title={root}>
                  Creates <span className="text-ide-muted">{root}</span>
                </p>
              )}

              <section aria-label="Files" className="mt-5">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ide-faint">
                  Files
                  {template?.createCommand
                    ? preview.some((f) => f.generated)
                      ? ' — including what the generator creates'
                      : ' — the generator creates the rest'
                    : ''}
                </h3>
                {preview.length === 0 ? (
                  <p className="rounded-md border border-dashed border-ide-border-soft px-3 py-4 text-center text-[10px] text-ide-faint">
                    This template does not declare any files.
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto rounded-md border border-ide-border-soft bg-ide-raised py-1.5">
                    {tree.map((node) => (
                      <TreeRow
                        key={node.path}
                        node={node}
                        depth={0}
                        entryFile={template?.entryFile ?? null}
                        autoOpen={entryDirs.has(node.path)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {template && (
                <label className="mt-4 flex items-start gap-2 text-[11px] text-ide-muted">
                  <input
                    type="checkbox"
                    checked={wantsInstall}
                    disabled={!installRunnable || busy}
                    onChange={(e) => setRunInstall(e.target.checked)}
                    className="mt-0.5 accent-ide-accent"
                  />
                  <span>
                    Run install after creation
                    {template.installCommand ? (
                      <code className="ml-1.5 rounded bg-ide-raised px-1.5 py-0.5 text-[10px] text-ide-fg">{template.installCommand}</code>
                    ) : (
                      <span className="ml-1.5 text-[10px] text-ide-faint">nothing to install</span>
                    )}
                  </span>
                </label>
              )}

              {error && (
                <p role="alert" className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {phase === 'confirm-overwrite' ? (
          <footer className="shrink-0 border-t border-ide-border-soft bg-ide-raised px-5 py-3">
            <p className="text-[11px] font-medium text-amber-400">
              {collisions.length} file{collisions.length === 1 ? '' : 's'} already exist here
            </p>
            <p className="mt-0.5 text-[10px] text-ide-muted">Overwriting replaces their contents. Files the template does not name are left alone.</p>
            <ul className="mt-2 max-h-24 overflow-y-auto rounded border border-ide-border-soft bg-ide-bg px-2 py-1.5 text-[10px] text-ide-faint">
              {collisions.map((p) => (
                <li key={p} className="truncate">{p}</li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCollisions([]);
                  setPhase('form');
                }}
                className="rounded-md border border-ide-border-soft px-3 py-1.5 text-[11px] text-ide-muted hover:border-ide-accent/50 hover:text-ide-fg"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void submit(true)}
                className="rounded-md border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-200 hover:bg-amber-500/25"
              >
                Overwrite and create
              </button>
            </div>
          </footer>
        ) : (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-ide-border-soft bg-ide-raised px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-ide-border-soft px-3 py-1.5 text-[11px] text-ide-muted hover:border-ide-accent/50 hover:text-ide-fg disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit(false)}
              disabled={busy || !template || !!nameCheck.error || !name.trim()}
              className="rounded-md border border-ide-accent bg-ide-accent/20 px-3 py-1.5 text-[11px] text-ide-fg hover:bg-ide-accent/30 disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Create Project'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
