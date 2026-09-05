"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { formatBytes } from "@/lib/extension/limits";
import { cn } from "@/lib/utils";
import type { ExtensionAnalysis, FileTreeNode } from "@/types/extension";

export function FilesCard({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const { tree, fileCount, totalUncompressedSize, rootLabel } = analysis.files;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(topLevelFolderPaths(tree)),
  );

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const topLevelExpand = useMemo(() => topLevelFolderPaths(tree), [tree]);

  const visibleTopLevel = expanded.has("__root__") || topLevelExpand.length === 0;

  return (
    <section className="card card-pad">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Files</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Package structure
          </h2>
        </div>
        <button
          type="button"
          onClick={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (visibleTopLevel) next.delete("__root__");
              else next.add("__root__");
              return next;
            })
          }
          className="inline-flex min-h-[44px] items-center gap-1 rounded-full px-3 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          {visibleTopLevel ? "Collapse" : "Expand"} all
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[360px]">
          <div className="rounded-xl border border-[var(--border)]">
            {tree.length === 0 ? (
              <p className="p-4 text-sm text-[var(--text-secondary)]">
                No files were found.
              </p>
            ) : (
              tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  visible={visibleTopLevel}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-secondary)]">
        <span>{fileCount} files</span>
        <span>{formatBytes(totalUncompressedSize)} uncompressed</span>
        <span>Root: {rootLabel}</span>
      </div>
    </section>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  visible,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  visible: boolean;
}) {
  const isFolder = node.type === "folder";
  const isExpanded = expanded.has(node.path);

  if (!visible && isFolder) return null;

  const hasChildren = isFolder && node.children.length > 0;
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 last:border-b-0",
        )}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        {isFolder ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
          >
            {hasChildren && isExpanded ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-secondary)]">
            <span className="sr-only">File</span>
          </span>
        )}
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[var(--accent)]">
          {isFolder ? (
            <Folder className="h-4 w-4" aria-hidden="true" />
          ) : (
            <File className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {node.name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">
          {isFolder ? `${node.children.length} items` : formatBytes(node.size)}
        </span>
      </div>
      {isFolder && isExpanded && hasChildren ? (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              visible
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function topLevelFolderPaths(tree: FileTreeNode[]): string[] {
  return tree.filter((node) => node.type === "folder").map((node) => node.path);
}
