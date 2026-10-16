import { OKVED2_TREE, getOkvedByCode, reduceToTopCodes, type OkvedNode } from './okved2';

type VisibleOkvedNode = OkvedNode & { searchAncestor?: boolean };

function allCodes(node: OkvedNode): string[] {
  return [node.code, ...(node.children ?? []).flatMap(allCodes)];
}

const nodesByCode = new Map<string, OkvedNode>();
function indexNodes(nodes: OkvedNode[]) {
  for (const node of nodes) {
    nodesByCode.set(node.code, node);
    indexNodes(node.children ?? []);
  }
}
indexNodes(OKVED2_TREE);

function ancestors(code: string): string[] {
  const result: string[] = [];
  let parent = getOkvedByCode(code)?.parent_code;
  while (parent) {
    result.push(parent);
    parent = getOkvedByCode(parent)?.parent_code;
  }
  return result;
}

export function filterOkvedTree(nodes: OkvedNode[], query: string): VisibleOkvedNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.flatMap((node) => {
    if (`${node.code} ${node.name}`.toLowerCase().includes(q)) return [node];
    const children = filterOkvedTree(node.children ?? [], q);
    return children.length ? [{ ...node, children, searchAncestor: true }] : [];
  });
}

export function getOkvedSelectionState(node: OkvedNode, selected: Set<string>): 'all' | 'partial' | 'none' {
  if ([node.code, ...ancestors(node.code)].some((code) => selected.has(code))) return 'all';
  const children = node.children ?? [];
  if (!children.length) return 'none';
  const states = children.map((child) => getOkvedSelectionState(child, selected));
  if (states.every((state) => state === 'all')) return 'all';
  return states.some((state) => state !== 'none') ? 'partial' : 'none';
}

/** A filtered ancestor is navigation, not a prefix covering its hidden children. */
function visibleBranches(node: VisibleOkvedNode): OkvedNode[] {
  const original = nodesByCode.get(node.code);
  if (original && !node.searchAncestor) return [original];
  return (node.children ?? []).flatMap(visibleBranches);
}

export function toggleVisibleOkved(node: OkvedNode, selected: Set<string>, remove = false): Set<string> {
  const next = new Set<string>();
  // Expand existing prefixes before subtraction so siblings remain selected.
  for (const code of selected) {
    const original = nodesByCode.get(code);
    for (const item of original ? allCodes(original) : [code]) next.add(item);
  }
  const deselect = remove || getOkvedSelectionState(node, selected) === 'all';
  for (const branch of visibleBranches(node)) {
    for (const code of allCodes(branch)) {
      if (deselect) next.delete(code);
      else next.add(code);
    }
    if (deselect) for (const parent of ancestors(branch.code)) next.delete(parent);
  }
  return new Set(reduceToTopCodes(next));
}

export function removeOkvedBranch(code: string, selected: Set<string>): Set<string> {
  const node = nodesByCode.get(code);
  if (node) return toggleVisibleOkved(node, selected, true);
  const next = new Set(selected);
  next.delete(code);
  return next;
}
