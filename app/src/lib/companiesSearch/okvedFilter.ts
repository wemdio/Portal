/**
 * Reduces a list of OKVED codes to the minimal set of prefixes
 * that covers all selected codes. Section letters (A-U) are
 * replaced by their child numeric division codes.
 *
 * Example: ["01", "01.1", "01.11", "01.12", "02"] → ["01", "02"]
 * because "01" already covers "01.1", "01.11", "01.12".
 */

import { OKVED2_TREE } from './okved2';

const sectionChildCodes = new Map<string, string[]>();
for (const section of OKVED2_TREE) {
  if (/^[A-U]$/i.test(section.code) && section.children) {
    sectionChildCodes.set(
      section.code,
      section.children.map((c) => c.code),
    );
  }
}

export function minimalOkvedPrefixes(codes: string[]): string[] {
  const expanded: string[] = [];
  for (const code of codes) {
    const children = sectionChildCodes.get(code);
    if (children) {
      expanded.push(...children);
    } else if (/^\d/.test(code)) {
      expanded.push(code);
    }
  }

  const unique = [...new Set(expanded)].sort();

  const result: string[] = [];
  for (const code of unique) {
    const last = result[result.length - 1];
    if (last !== undefined && code.startsWith(last)) {
      continue;
    }
    result.push(code);
  }

  return result;
}
