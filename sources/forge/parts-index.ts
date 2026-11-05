/**
 * Flat view of the category tree: every category becomes one scrolling grid made
 * of labeled sections, so nothing is ever hidden behind a collapsed level.
 */
import type { CategoryTreeNode } from "../state/catalog.ts";

type TreeNode = CategoryTreeNode & { priority?: number; label?: string };

export type PartSection = {
  readonly key: string;
  readonly label: string;
  readonly itemIds: readonly string[];
};

export type PartCategory = {
  readonly key: string;
  readonly label: string;
  readonly sections: readonly PartSection[];
};

const WORD_FIXES: Record<string, string> = {
  hairextl: "Hair Extension Left",
  hairextr: "Hair Extension Right",
  "1h": "One-Handed",
};

export function humanize(key: string): string {
  if (WORD_FIXES[key]) return WORD_FIXES[key];
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => WORD_FIXES[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function sortedChildren(node: TreeNode): [string, TreeNode][] {
  return Object.entries(node.children ?? {}).sort(
    ([aKey, a], [bKey, b]) =>
      ((a as TreeNode).priority ?? 1000) - ((b as TreeNode).priority ?? 1000) ||
      aKey.localeCompare(bKey),
  ) as [string, TreeNode][];
}

function collectSections(
  node: TreeNode,
  path: readonly string[],
  into: PartSection[],
): void {
  if (node.items?.length) {
    into.push({
      key: path.join("/") || "top",
      label: path.map(humanize).join(" / "),
      itemIds: node.items,
    });
  }
  for (const [key, child] of sortedChildren(node)) {
    collectSections(child, [...path, key], into);
  }
}

export function buildPartCategories(root: CategoryTreeNode): PartCategory[] {
  return sortedChildren(root).map(([key, node]) => {
    const sections: PartSection[] = [];
    collectSections(node, [], sections);
    return {
      key,
      label: node.label ?? humanize(key),
      sections,
    };
  });
}

/** Every word of the query must appear in the part's name, slot, or section. */
export function matchesPartSearch(
  query: string,
  haystacks: readonly string[],
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystacks.join(" ").toLowerCase().replaceAll("_", " ");
  return words.every((w) => text.includes(w));
}
