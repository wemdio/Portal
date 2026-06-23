# Signals "Удалить недоступные" Checkbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "delete rows where website was unreachable" checkbox to the Signals modal; after the job completes, client-side splice those rows out of the active tab.

**Architecture:** One new pure helper (`removeSignalErrorRows`) tested with Jest. Wired into `SignalEnrichmentModal` as a checkbox and into `DatabaseSpreadsheet.runSignalJobPolling` post-completion. Preference persisted in `localStorage` under a new key. The error indicator is the `⚠` marker in the Стек column (single source of truth — `SIGNAL_ERROR_MARKER` from `signalConstants.ts`).

**Tech Stack:** Next.js 14, React, TypeScript, Jest 29. No new deps.

**Spec:** [docs/superpowers/specs/2026-06-22-signals-cleanup-checkbox-design.md](../specs/2026-06-22-signals-cleanup-checkbox-design.md)

---

## File Structure

- **Create:**
  - `app/src/lib/spreadsheet/removeSignalErrorRows.ts` — pure helper. Takes `tabData` + `stackColIndex`, returns `{ nextData, removed }`.
  - `app/tests/lib/removeSignalErrorRows.test.ts` — Jest tests for the helper.
- **Modify:**
  - `app/src/components/SignalEnrichmentModal.tsx` — extend state shape with `removeUnreachableAfterDone`; add a checkbox UI block above the footer; new prop `onToggleRemoveUnreachable`.
  - `app/src/components/DatabaseSpreadsheet.tsx` — add field to `signalEnrichment` state, add new storage key constant, load on modal open, persist on toggle, expose `onToggleRemoveUnreachable` callback, and trigger cleanup inside `runSignalJobPolling` right after the polling loop completes successfully.

---

### Task 1: Pure cleanup helper with TDD

**Files:**
- Create: `app/src/lib/spreadsheet/removeSignalErrorRows.ts`
- Test: `app/tests/lib/removeSignalErrorRows.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/tests/lib/removeSignalErrorRows.test.ts`:

```ts
/** @jest-environment node */

import { removeSignalErrorRows } from '@/lib/spreadsheet/removeSignalErrorRows';
import { SIGNAL_ERROR_MARKER } from '@/lib/enrich/signalConstants';

const STACK_COL = 3;

function row(site: string, stack: string): string[] {
  // [Сайт, _, _, Стек, Профиль]
  return [site, '', '', stack, ''];
}

describe('removeSignalErrorRows', () => {
  it('keeps header and rows without error marker', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('ok.ru', 'GA, AmoCRM'),
      row('also-ok.ru', 'Tilda'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('drops rows whose stack cell is exactly the error marker', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('ok.ru', 'GA'),
      row('dead.ru', SIGNAL_ERROR_MARKER),
      row('also-dead.ru', SIGNAL_ERROR_MARKER),
      row('alive.ru', 'WordPress'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(2);
    expect(result.nextData).toHaveLength(3); // header + 2 alive
    expect(result.nextData[0]).toEqual(data[0]); // header preserved
    expect(result.nextData.map((r) => r[0])).toEqual(['Сайт', 'ok.ru', 'alive.ru']);
  });

  it('treats whitespace around the marker as match (defensive)', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('dead.ru', `  ${SIGNAL_ERROR_MARKER}  `),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(1);
    expect(result.nextData).toHaveLength(1); // only header remains
  });

  it('keeps row when stack cell is undefined (short row) — not an error', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      ['short.ru', '', ''], // shorter than STACK_COL+1
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('keeps header even if it accidentally contains the marker', () => {
    const data = [
      ['Сайт', 'A', 'B', SIGNAL_ERROR_MARKER, 'Профиль'],
      row('ok.ru', 'GA'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('empty data returns empty', () => {
    const result = removeSignalErrorRows([], STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `app/`:
```
npx jest tests/lib/removeSignalErrorRows.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/spreadsheet/removeSignalErrorRows'".

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/spreadsheet/removeSignalErrorRows.ts`:

```ts
import { SIGNAL_ERROR_MARKER } from '@/lib/enrich/signalConstants';

export interface RemoveSignalErrorRowsResult {
  nextData: string[][];
  removed: number;
}

/**
 * Возвращает новый tabData без строк где в колонке `stackColIndex` стоит
 * маркер ошибки `⚠` (что бы ни было в Профиле — текст ошибки или пусто).
 *
 * Строка 0 (header) сохраняется всегда — даже если в её stack-ячейке
 * случайно оказался маркер. Чистая функция: не мутирует вход.
 *
 * Используется чекбоксом «удалить недоступные» в модалке сигналов:
 * клиентская пост-обработка после завершения signal-job'a.
 */
export function removeSignalErrorRows(
  tabData: string[][],
  stackColIndex: number,
): RemoveSignalErrorRowsResult {
  if (tabData.length === 0) return { nextData: [], removed: 0 };

  const header = tabData[0];
  const kept: string[][] = [header];
  let removed = 0;

  for (let i = 1; i < tabData.length; i += 1) {
    const row = tabData[i];
    const cell = String(row[stackColIndex] ?? '').trim();
    if (cell === SIGNAL_ERROR_MARKER) {
      removed += 1;
      continue;
    }
    kept.push(row);
  }

  return { nextData: kept, removed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/lib/removeSignalErrorRows.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/spreadsheet/removeSignalErrorRows.ts app/tests/lib/removeSignalErrorRows.test.ts
git commit -m "feat(signals): pure helper removeSignalErrorRows + tests"
```

---

### Task 2: Extend modal state shape + checkbox UI

**Files:**
- Modify: `app/src/components/SignalEnrichmentModal.tsx`

- [ ] **Step 1: Extend state interface**

In `SignalEnrichmentModal.tsx`, find `SignalEnrichmentModalState` (around line 18). Add field after `cascadeToast`:

```ts
  cascadeToast: string | null;
  /**
   * Чекбокс «после обработки удалить строки с ошибкой загрузки сайта».
   * Сравнение идёт по маркеру `⚠` в Стеке (см. signalConstants), что покрывает
   * все типы провала: «Сайт недоступен», «Превышено время ожидания», DNS, SSL и т.п.
   * Дефолт: false. Запоминается в localStorage между сессиями.
   */
  removeUnreachableAfterDone: boolean;
}
```

- [ ] **Step 2: Add prop callback**

In the same file, find `interface Props` (around line 40). Add right after `onToggleExtractor`:

```ts
  onToggleExtractor: (key: ExtractorKey) => void;
  onToggleRemoveUnreachable: () => void;
  onClose: () => void;
```

- [ ] **Step 3: Destructure the new prop**

In the component function signature, add `onToggleRemoveUnreachable` to the destructured props list (around line 115):

```ts
  onToggleExtractor,
  onToggleRemoveUnreachable,
  onClose,
```

- [ ] **Step 4: Render the checkbox**

Find the scrollable body section closing — the line right after the Error block (`{state.error && (...)}`, around line 435). Insert a new block between that error block and the closing `</div>` of the body. The new block:

```tsx
          {/* Cleanup checkbox — выполнится клиентски после завершения job'a */}
          <label
            className={`flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50/40 px-3 py-2.5 cursor-pointer transition hover:bg-gray-50 ${
              state.isProcessing ? 'opacity-60 cursor-not-allowed' : ''
            }`}
          >
            <input
              type="checkbox"
              checked={state.removeUnreachableAfterDone}
              disabled={state.isProcessing}
              onChange={onToggleRemoveUnreachable}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">
                После обработки удалить строки с ошибкой загрузки сайта
              </p>
              <p className="text-[11px] text-gray-500">
                Сайт недоступен / Превышено время ожидания / DNS-ошибки и т.п. — останутся только сайты, готовые к аналитике.
              </p>
            </div>
          </label>
```

- [ ] **Step 5: Commit**

```bash
git add app/src/components/SignalEnrichmentModal.tsx
git commit -m "feat(signals-modal): checkbox to delete unreachable rows post-run"
```

---

### Task 3: Parent state + localStorage + handler in DatabaseSpreadsheet

**Files:**
- Modify: `app/src/components/DatabaseSpreadsheet.tsx`

- [ ] **Step 1: Add new storage key constant**

Find the existing constants around line 320–321:

```ts
const SIGNAL_PRESETS_STORAGE_KEY = 'signal-enrichment-presets-v1';
const SIGNAL_LAST_SELECTION_STORAGE_KEY = 'signal-enrichment-last-selection-v1';
```

Add immediately after:

```ts
const SIGNAL_REMOVE_UNREACHABLE_STORAGE_KEY = 'signal-enrichment-remove-unreachable-v1';
```

- [ ] **Step 2: Extend initial state**

Find `useState<SignalEnrichmentState>(...)` around line 1567. The initial object has fields like `isOpen`, `sourceCol`, ..., `cascadeToast`. Add a new field at the end of the object (before the closing `}`):

```ts
    cascadeToast: null,
    removeUnreachableAfterDone: false,
  });
```

Also update the `SignalEnrichmentState` type. Search for `type SignalEnrichmentState` or `interface SignalEnrichmentState` in the file and add `removeUnreachableAfterDone: boolean;` to it. If the parent type imports from the modal file, this is already covered by Task 2 — verify whether the state type is local to DatabaseSpreadsheet or re-uses `SignalEnrichmentModalState`. If local, add the field there too.

- [ ] **Step 3: Load preference from localStorage**

In the existing load-on-open `useEffect` (around line 7906), inside the `try` block right after the `lastRaw`/`lastSelection` parsing, add:

```ts
      const removeUnreachableRaw = window.localStorage.getItem(SIGNAL_REMOVE_UNREACHABLE_STORAGE_KEY);
      const removeUnreachable = removeUnreachableRaw === 'true';
```

Then in the `setSignalEnrichment` call inside the same effect, add the field:

```ts
      setSignalEnrichment((prev) => ({
        ...prev,
        customPresets,
        selectedExtractors: ...,
        presetId: lastSelection?.presetId ?? prev.presetId,
        removeUnreachableAfterDone: removeUnreachable,
      }));
```

- [ ] **Step 4: Add the toggle handler**

Find `toggleSignalExtractor` (around line 7955). Add a new handler right after its closing brace:

```ts
  const toggleRemoveUnreachableAfterDone = useCallback(() => {
    setSignalEnrichment((prev) => {
      const next = !prev.removeUnreachableAfterDone;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(SIGNAL_REMOVE_UNREACHABLE_STORAGE_KEY, String(next));
        } catch {
          /* private mode — ignore */
        }
      }
      return { ...prev, removeUnreachableAfterDone: next };
    });
  }, [setSignalEnrichment]);
```

- [ ] **Step 5: Wire handler into modal props**

Find the `<SignalEnrichmentModal ...>` JSX block (around line 13222). Find the `onToggleExtractor={...}` prop and add right after:

```tsx
          onToggleExtractor={toggleSignalExtractor}
          onToggleRemoveUnreachable={toggleRemoveUnreachableAfterDone}
```

- [ ] **Step 6: Commit**

```bash
git add app/src/components/DatabaseSpreadsheet.tsx
git commit -m "feat(signals): wire removeUnreachable state + localStorage persistence"
```

---

### Task 4: Trigger cleanup on signal-job completion

**Files:**
- Modify: `app/src/components/DatabaseSpreadsheet.tsx`

- [ ] **Step 1: Add import**

At the top of `DatabaseSpreadsheet.tsx`, near the other spreadsheet helper imports, add:

```ts
import { removeSignalErrorRows } from '@/lib/spreadsheet/removeSignalErrorRows';
```

- [ ] **Step 2: Run cleanup after polling completes**

In `runSignalJobPolling` (around line 7873), find the success path:

```ts
      setLastAction({
        message: errorCount > 0
          ? `Сигналы: ${processedCount - errorCount} обработано, ${errorCount} ошибок`
          : `Анализ сигналов завершён: ${processedCount} сайтов`,
        time: Date.now(),
      });
      setSignalEnrichment((prev) => ({
        ...prev,
        isProcessing: false,
        ...
```

Replace this block with:

```ts
      let cleanupRemoved = 0;
      let shouldCleanup = false;
      // Берём актуальное значение чекбокса через функциональный setState — чтобы
      // не таскать removeUnreachableAfterDone через deps useCallback'a (это
      // привело бы к пересозданию runSignalJobPolling на каждый тогл).
      setSignalEnrichment((prev) => {
        shouldCleanup = prev.removeUnreachableAfterDone;
        return prev;
      });

      if (shouldCleanup) {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId) return tab;
            const result = removeSignalErrorRows(tab.data, stackColIndex);
            cleanupRemoved = result.removed;
            return cleanupRemoved > 0 ? { ...tab, data: result.nextData } : tab;
          }),
        );
      }

      const baseMsg = errorCount > 0
        ? `Сигналы: ${processedCount - errorCount} обработано, ${errorCount} ошибок`
        : `Анализ сигналов завершён: ${processedCount} сайтов`;
      const cleanupSuffix = cleanupRemoved > 0
        ? `. Удалено ${cleanupRemoved} ${cleanupRemoved === 1 ? 'строка' : cleanupRemoved < 5 ? 'строки' : 'строк'} с ошибками загрузки`
        : '';
      setLastAction({
        message: baseMsg + cleanupSuffix,
        time: Date.now(),
      });
      setSignalEnrichment((prev) => ({
        ...prev,
        isProcessing: false,
        isOpen: false,
        jobId: null,
        startedAt: null,
        detectedJob: null,
      }));
```

- [ ] **Step 3: Run all tests to verify nothing broke**

From `app/`:
```
npx jest
```
Expected: all tests pass including the new `removeSignalErrorRows` suite.

- [ ] **Step 4: Type-check the changes**

From `app/`:
```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/DatabaseSpreadsheet.tsx
git commit -m "feat(signals): post-job cleanup of rows with stack=⚠ when checkbox is on"
```

---

### Task 5: Manual smoke verification

**Files:** none.

- [ ] **Step 1: Start dev server via preview tools**

Use `mcp__Claude_Preview__preview_start` to start the Next.js dev server on the portal app. Wait for "compiled successfully".

- [ ] **Step 2: Verify checkbox renders + persists**

In the running app:
1. Open the signals modal in a spreadsheet with at least one row.
2. Confirm the checkbox renders above the footer with the right copy.
3. Toggle it on → close modal → reopen → checkbox is on.
4. Toggle it off → close → reopen → checkbox is off.
5. Reload the whole page → reopen modal → state matches what was last set.

Capture a `preview_screenshot` of the modal with the checkbox visible.

- [ ] **Step 3: Verify the cleanup runs on a small job**

If a real signal-job can be cheaply run (1-3 URLs including one obviously-dead like `definitely-not-a-real-site-xyz.test`):
1. Enable the checkbox.
2. Start the job.
3. After completion, confirm the dead row is gone from the tab.
4. Confirm `lastAction` toast says e.g. "Анализ сигналов завершён: 3 сайтов. Удалено 1 строка с ошибками загрузки".

If running a real job isn't feasible in dev, document this step as deferred to user verification on prod and proceed.

- [ ] **Step 4: Final commit (if any minor fixups needed)**

If you needed to tweak anything during smoke test, commit with:
```bash
git commit -m "fix(signals): tweak based on smoke test"
```

Otherwise nothing to commit. Done.

---

## Self-Review Notes

- ✅ **Spec coverage:** Every item in spec is covered: UI checkbox (Task 2), localStorage (Task 3), cleanup logic (Task 4), pure-function test (Task 1), smoke (Task 5), tabId-not-activeTabId rule (Task 4 uses `tabId` from polling params).
- ✅ **No placeholders:** Every step has code or exact commands.
- ✅ **Type consistency:** `removeUnreachableAfterDone` used everywhere with the same name. `removeSignalErrorRows` signature consistent across helper, test, and call site. `cleanupRemoved` declared and read in the same scope.
- ✅ **Pluralisation in toast:** correct Russian forms ("строка"/"строки"/"строк") via inline ternary — could be a util but YAGNI.
