"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  VeHypothesis,
  VeTemplate,
  VeVertical,
} from "@/lib/verticalEngineV2/types";
import { normalizeVeFinalLetters } from "@/lib/verticalEngineV2/finalLetters";
import { parseLaunchInfo } from "@/lib/verticalEngineV2/launchHandoff";
import type { VeBaseSummary, VeJobSummary } from "./api";
import { HE } from "./design";
import { formatDate } from "./ui";
import { FinalLettersEditor } from "./FinalLettersEditor";
import { Step4Base } from "./steps/Step4Base";
import { Step5Template } from "./steps/Step5Template";

interface ManualBaseLibraryProps {
  projectId: string;
  verticals: VeVertical[];
  hypotheses: VeHypothesis[];
  bases: VeBaseSummary[];
  templates: VeTemplate[];
  jobs: VeJobSummary[];
  parentPollingActive?: boolean;
  onUpdated: () => void | Promise<void>;
  /** Dirty state of this library's editor, independent of the main wizard. */
  onDirtyChange: (dirty: boolean) => void;
}

/** Secondary path. Uses the existing upload, final-letter and single-base launch APIs. */
export function ManualBaseLibrary({
  projectId,
  verticals,
  hypotheses,
  bases,
  templates,
  jobs,
  parentPollingActive = false,
  onUpdated,
  onDirtyChange,
}: ManualBaseLibraryProps) {
  const [verticalId, setVerticalId] = useState(verticals[0]?.id ?? "");
  const [baseId, setBaseId] = useState(
    () =>
      bases
        .filter(
          (base) =>
            base.vertical_id === verticals[0]?.id &&
            base.collect_info?.collection_mode !== "supply",
        )
        .sort(
          (a, b) =>
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        )[0]?.id ?? "",
  );
  const [dirty, setDirty] = useState(false);
  const [refreshingLetters, setRefreshingLetters] = useState(false);
  const lettersRef = useRef<HTMLElement>(null);
  const vertical =
    verticals.find((item) => item.id === verticalId) ?? verticals[0] ?? null;
  const availableBases = useMemo(
    () =>
      bases
        .filter(
          (base) =>
            base.vertical_id === vertical?.id &&
            base.collect_info?.collection_mode !== "supply",
        )
        .sort(
          (a, b) =>
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        ),
    [bases, vertical?.id],
  );
  const base =
    availableBases.find((item) => item.id === baseId) ??
    availableBases[0] ??
    null;
  const template = useMemo(
    () =>
      templates
        .filter(
          (item) =>
            item.base_id === base?.id &&
            !(item as VeTemplate & { supply_batch_id?: string })
              .supply_batch_id,
        )
        .sort(
          (a, b) =>
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        )[0] ?? null,
    [templates, base?.id],
  );
  const displayedBaseId = base?.id;
  const displayedVerticalId = vertical?.id;
  const changeDirty = useCallback(
    (value: boolean) => {
      // Data can arrive after the first render, leaving the initial IDs empty.
      // Pin the displayed defaults before edits so polling cannot select a new
      // first base/vertical and replace the editor with unsaved changes.
      if (value) {
        if (displayedVerticalId) setVerticalId(displayedVerticalId);
        if (displayedBaseId) setBaseId(displayedBaseId);
      }
      setDirty(value);
      onDirtyChange(value);
    },
    [displayedBaseId, displayedVerticalId, onDirtyChange],
  );
  const uploaded = useCallback(
    (createdId?: string) => {
      if (createdId) setBaseId(createdId);
      void onUpdated();
    },
    [onUpdated],
  );
  const updatedLetters = useCallback(async () => {
    setRefreshingLetters(true);
    try {
      await onUpdated();
    } finally {
      setRefreshingLetters(false);
    }
  }, [onUpdated]);
  const openLetters = useCallback(() => {
    lettersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const lettersConfirmed = Boolean(
    template?.letters.length &&
    template.letters.every(
      (letter) =>
        letter.selected_variant === "A" || letter.selected_variant === "B",
    ) &&
    normalizeVeFinalLetters(template.letters).letters,
  );
  const recorded =
    template &&
    parseLaunchInfo(
      (template as VeTemplate & { launch_info?: unknown }).launch_info,
    );

  if (!vertical)
    return (
      <p className={HE.muted}>
        Сначала подготовьте гипотезы: файл загружается под одну из вертикалей
        проекта.
      </p>
    );

  return (
    <div className="space-y-5">
      <p className={HE.muted}>
        Здесь можно загрузить свой файл или продолжить работу с прежней базой.
        Для загруженного файла контакты передаются в кампанию один раз: файл не
        подключается к ежедневному автопоиску.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block ve2-label">
          Вертикаль для базы
          <select
            value={vertical.id}
            className={`${HE.input} mt-2 w-full`}
            disabled={dirty || refreshingLetters}
            onChange={(event) => {
              setVerticalId(event.target.value);
              setBaseId(
                bases
                  .filter(
                    (item) =>
                      item.vertical_id === event.target.value &&
                      item.collect_info?.collection_mode !== "supply",
                  )
                  .sort(
                    (a, b) =>
                      b.created_at.localeCompare(a.created_at) ||
                      b.id.localeCompare(a.id),
                  )[0]?.id ?? "",
              );
            }}
          >
            {verticals.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block ve2-label">
          Прежняя база
          <select
            value={base?.id ?? ""}
            className={`${HE.input} mt-2 w-full`}
            disabled={dirty || refreshingLetters || !availableBases.length}
            onChange={(event) => setBaseId(event.target.value)}
          >
            {!availableBases.length ? (
              <option value="">Пока нет загруженных баз</option>
            ) : null}
            {availableBases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.filename} · {item.row_count.toLocaleString("ru-RU")} строк
                · {formatDate(item.created_at)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {dirty ? (
        <p role="status" className={HE.muted}>
          Сохраните или отмените правки писем, чтобы выбрать другую базу или
          перейти к запуску.
        </p>
      ) : null}
      <fieldset disabled={dirty || refreshingLetters} className="min-w-0">
        <Step4Base
          key={vertical.id}
          projectId={projectId}
          vertical={vertical}
          hypotheses={hypotheses}
          bases={bases}
          selectedBaseId={base?.id}
          jobs={jobs}
          uploadOnly
          templateReady={template?.status === "ready"}
          parentPollingActive={parentPollingActive}
          onUploaded={uploaded}
          onTemplateStarted={uploaded}
          onGoToTemplate={openLetters}
        />
      </fieldset>
      {template ? (
        <section
          ref={lettersRef}
          className="space-y-5"
          aria-label="Письма и запуск выбранной базы"
        >
          <h3 className="text-lg font-semibold">
            Итоговые письма для базы «{base?.filename}»
          </h3>
          <FinalLettersEditor
            templateId={template.id}
            onSaved={updatedLetters}
            onDirtyChange={changeDirty}
          />
          {base?.collect_info?.collection_mode === "preview" ? (
            <p className={HE.muted}>
              Эта база подготовлена автосбором. При продолжении запуска
              сохраняется согласование ежедневного пополнения из источников.
            </p>
          ) : null}
          {!dirty && !refreshingLetters && (lettersConfirmed || recorded) ? (
            <Step5Template
              key={`${template.id}:${template.updated_at}`}
              template={template}
              base={base}
              jobs={jobs}
              launchOnly
              onBuildTemplate={openLetters}
            />
          ) : (
            <p className={HE.muted}>
              {refreshingLetters
                ? "Обновляем сохранённые письма…"
                : "Перед запуском сохраните выбор текста и тем в редакторе выше."}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
