'use client';

import React from 'react';
import { Icon } from '../Icon';

interface BreadcrumbProps {
  /** Full absolute path of the active file (may be empty for scratch files). */
  path: string;
  /** File name segment shown as the last, active crumb. */
  fileName: string;
  dirty?: boolean;
}

function splitPath(path: string): string[] {
  if (!path) return [];
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * Dedicated breadcrumb sub-header rendered above the editor tabs.
 * Example:  kyle > kb > __init__.py
 */
export default function Breadcrumb({ path, fileName, dirty = false }: BreadcrumbProps) {
  const parts = splitPath(path);

  return (
    <div className="flex items-center gap-1 h-6 px-3 bg-ide-bg border-b border-ide-border-soft text-[11px] text-ide-muted overflow-hidden whitespace-nowrap select-none">
      <Icon name="file-code" size={11} className="text-ide-muted mr-1 shrink-0" />
      {parts.length === 0 ? (
        <span className="text-ide-faint">untitled scratch</span>
      ) : (
        <>
          {parts.map((seg, i) => {
            const isLast = i === parts.length - 1;
            if (isLast) {
              return (
                <React.Fragment key={i}>
                  <span className={`shrink-0 ${dirty ? 'text-ide-accent-bright' : 'text-ide-fg'}`}>
                    {seg}
                    {dirty && <span className="ml-1 text-ide-accent-bright">●</span>}
                  </span>
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={i}>
                <span className="shrink-0">{seg}</span>
                <Icon name="chevron-right" size={10} className="text-ide-faint shrink-0" />
              </React.Fragment>
            );
          })}
          {nameDiffers(fileName, parts) && (
            <>
              <Icon name="chevron-right" size={10} className="text-ide-faint shrink-0" />
              <span className={`shrink-0 ${dirty ? 'text-ide-accent-bright' : 'text-ide-fg'}`}>
                {fileName}
                {dirty && <span className="ml-1 text-ide-accent-bright">●</span>}
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}

function nameDiffers(fileName: string, parts: string[]): boolean {
  return parts.length > 0 && parts[parts.length - 1] !== fileName;
}