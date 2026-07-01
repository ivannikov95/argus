import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "./api";
import type { ExportOptions, ProjectMeta } from "./api";
import type { AnalysisRow, Dataset, VariableSchema, TableSlide, TableEditorSettings, GroupSlot, LogisticTableWorkspace, RegressionWorkspace, CorrelationWorkspace } from "./types";
import { clearWorkspaceDraft, loadWorkspaceDraft, saveWorkspaceDraft } from "./draftStore";
import { DEFAULT_SETTINGS, download, formatTableCaption, makeSlide, slidesForDataset, regressionForDataset } from "./utils";
import { HomePage } from "./pages/HomePage";
import { DatasetPage } from "./pages/DatasetPage";
import { VariablesPage } from "./pages/VariablesPage";
import { TablePage } from "./pages/TablePage";
import { LogisticTablePage } from "./pages/LogisticPage";
import { RegressionPage } from "./pages/RegressionPage";
import { CorrelationPage } from "./pages/CorrelationPage";
import { ReportPreviewPage } from "./pages/ReportPage";

type Page = "home" | "dataset" | "variables" | "table" | "regression" | "modeling" | "correlation" | "report";

interface WorkspaceDraft {
  dataset: Dataset;
  schema: VariableSchema[];
  slides: TableSlide[];
  currentIndex: number;
  projectName: string;
  page: Page;
  regression?: RegressionWorkspace;
  correlation?: CorrelationWorkspace;
}

function ArgusMark({ className = "" }: { className?: string }) {
  return <img className={`argus-mark ${className}`.trim()} src="/argus-mark.svg" alt="" aria-hidden="true" />;
}

function projectIdFromPath(pathname: string) {
  const encodedId = pathname.match(/^\/project\/([^/]+)/)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

const nav: { id: Page | string; label: string; mark: string; enabled: boolean }[] = [
  { id: "home", label: "Главная", mark: "◎", enabled: true },
  { id: "dataset", label: "Датасет", mark: "▦", enabled: true },
  { id: "variables", label: "Переменные", mark: "≡", enabled: true },
  { id: "table", label: "Описательная статистика", mark: "▥", enabled: true },
  { id: "regression", label: "Регрессионный анализ", mark: "∑", enabled: true },
  { id: "modeling", label: "Моделирование", mark: "◈", enabled: true },
  { id: "report", label: "Отчёт", mark: "▤", enabled: true },
  { id: "correlation", label: "Корреляции", mark: "⌁", enabled: true },
  { id: "survival", label: "Выживаемость", mark: "◷", enabled: false },
];

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  // Read URL once synchronously to set correct initial state — no home-page flash
  const [page, setPage] = useState<Page>(() => {
    const m = window.location.pathname.match(/\/(dataset|variables|table|regression|correlation|report)$/);
    return (m?.[1] as Page) ?? "home";
  });
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [schema, setSchema] = useState<VariableSchema[]>([]);
  const [slides, setSlides] = useState<TableSlide[]>([makeSlide({ id: "s1" })]);
  const [regression, setRegression] = useState<RegressionWorkspace>({ outcome: "", predictors: [], confidenceLevel: 0.95, cutoff: 0.5, result: null });
  const [logisticTable, setLogisticTable] = useState<LogisticTableWorkspace>({ outcome: "", rows: [], multiResult: null, multiLoading: false });
  const [correlation, setCorrelation] = useState<CorrelationWorkspace>({ variables: [], method: "auto", result: null, includeMatrix: false, reportPairs: [] });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [projectName, setProjectName] = useState("Новое исследование");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "dirty">("dirty");
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [savedProjects, setSavedProjects] = useState<ProjectMeta[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  // true while loading a project from URL — set synchronously so first render shows spinner
  const [restoring, setRestoring] = useState(true);
  // project ID extracted from URL for startup load
  const startupPid = useRef(projectIdFromPath(window.location.pathname));
  const startupPage = useRef(page);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skipNextAutoSave = useRef(false); // prevents auto-save right after project load

  useEffect(() => {
    if (!notice) return;
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(noticeTimer.current);
  }, [notice]);

  // Current slide (all derived — never store group/selected/analysis/settings directly)
  const slide = slides[Math.min(currentIndex, slides.length - 1)];
  const group = slide.group;
  const selected = slide.selected;
  const analysis = slide.analysis;
  const tableSettings = slide.settings;

  const patchSlide = (index: number, patch: Partial<TableSlide>) =>
    setSlides((prev) => prev.map((s, i) => i === index ? { ...s, ...patch } : s));

  const updateSlide = (patch: Partial<TableSlide>) => patchSlide(currentIndex, patch);

  const setGroup = (v: string | null) => updateSlide({ group: v, groupSlots: [], analysis: null });
  const setGroupSlots = (v: GroupSlot[]) => updateSlide({ groupSlots: v });
  const setSelected = (v: string[]) => updateSlide({ selected: v });
  const setTableSettings = (v: TableEditorSettings) => updateSlide({ settings: v });

  const addSlide = () => {
    const num = slides.length + 1;
    const newSlide = makeSlide({
      id: `s${Date.now()}`,
      group: slide.group,
      selected: [...slide.selected],
      settings: {
        ...slide.settings,
        title: `Таблица ${num} - Без названия`,
        description: "",
        footnotes: "",
      },
    });
    setSlides((prev) => [...prev, newSlide]);
    setCurrentIndex(slides.length);
  };

  const deleteCurrentSlide = () => {
    if (slides.length === 1) return;
    setSlides((prev) => prev.filter((_, i) => i !== currentIndex));
    setCurrentIndex((i) => Math.min(i, slides.length - 2));
  };

  const setNewDataset = (next: Dataset) => {
    setDataset(next);
    setSchema(next.schema);
    setSlides(slidesForDataset(next));
    setRegression(regressionForDataset(next));
    setCurrentIndex(0);
  };

  const refreshProjects = () => { api.listProjects().then(setSavedProjects).catch(() => {}); };

  // On mount: restore project from URL (e.g. /project/some-id/table on refresh)
  useEffect(() => {
    refreshProjects();
    const pid = startupPid.current;
    if (pid) {
      loadProject(pid, startupPage.current).then((loaded) => {
        if (!loaded) {
          setPage("home");
          navigate("/", { replace: true });
        }
      }).finally(() => setRestoring(false));
    } else {
      loadWorkspaceDraft<WorkspaceDraft>().then((draft) => {
        if (draft?.dataset?.rows && Array.isArray(draft.slides)) {
          setDataset(draft.dataset);
          setSchema(draft.schema?.length ? draft.schema : draft.dataset.schema);
          setSlides(draft.slides.map((item) => makeSlide({ ...item, settings: { ...DEFAULT_SETTINGS, ...item.settings } })));
          setCurrentIndex(Math.min(draft.currentIndex ?? 0, Math.max(draft.slides.length - 1, 0)));
          setProjectName(draft.projectName || "Новое исследование");
          setRegression(draft.regression ?? regressionForDataset(draft.dataset));
          setPage(draft.page === "home" ? "home" : draft.page || "dataset");
        } else if (/^\/project\//.test(window.location.pathname)) {
          setPage("home");
          navigate("/", { replace: true });
        }
      }).catch(() => {
        setPage("home");
      }).finally(() => setRestoring(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDemo = async () => {
    setBusy("Загрузка демонстрационных данных…");
    try {
      setNewDataset(await api.demo());
      setCurrentProjectId(null);
      setSaveStatus("dirty");
      setPage("dataset");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось загрузить демо");
    } finally { setBusy(""); }
  };

  const candidateGroups = useMemo(
    () => schema.filter((v) => v.role !== "id" && ["binary", "categorical"].includes(v.type) && v.unique <= 8),
    [schema],
  );

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(`Читаю ${file.name}…`);
    try {
      const next = await api.upload(file);
      const nextSlides = slidesForDataset(next);
      const nextRegression = regressionForDataset(next);
      setNewDataset(next);
      if (currentProjectId) {
        await api.saveProject({
          project_id: currentProjectId,
          project_name: projectName,
          file_name: next.file_name,
          rows: next.rows,
          variable_overrides: Object.fromEntries(next.schema.map((item) => [item.name, item])),
          slides: nextSlides,
          regression: nextRegression,
          last_analysis: null,
          table_settings: nextSlides[0].settings,
        });
        setSaveStatus("saved");
        refreshProjects();
      } else {
        const nextName = file.name.replace(/\.[^.]+$/, "");
        setProjectName(nextName);
        setSaveStatus("dirty");
        await saveWorkspaceDraft<WorkspaceDraft>({
          dataset: next,
          schema: next.schema,
          slides: nextSlides,
          currentIndex: 0,
          projectName: nextName,
          page: "dataset",
          regression: nextRegression,
        });
      }
      setPage("dataset");
      setNotice("Датасет загружен и проверен");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось загрузить файл");
    } finally { setBusy(""); }
  };

  const loadProject = async (projectId: string, preferredPage?: Page) => {
    setBusy("Загружаю проект…");
    try {
      const saved = await api.loadProject(projectId);
      const ds = await api.profileDataset(saved.rows, saved.file_name);
      const overrides = saved.variable_overrides as Record<string, VariableSchema>;
      const mergedSchema = ds.schema.map((col) => overrides[col.name] ? { ...col, ...overrides[col.name] } : col);
      setDataset(ds);
      setSchema(mergedSchema);
      setRegression(saved.regression ?? regressionForDataset(ds));
      if (saved.slides && saved.slides.length > 0) {
        setSlides(saved.slides.map((s) => makeSlide({
          id: s.id || `s${Math.random().toString(36).slice(2)}`,
          group: s.group ?? null,
          selected: (s.selected as string[]) ?? [],
          settings: { ...DEFAULT_SETTINGS, ...(s.settings as Partial<TableEditorSettings>) },
          analysis: (s.analysis as import("./types").TableOneAnalysis) ?? null,
        })));
      } else {
        // backward compat: old saves without slides array
        const groupCol =
          mergedSchema.find((v) => v.role === "group")?.name ??
          mergedSchema.find((v) => ["binary", "categorical"].includes(v.type) && v.role !== "id" && v.unique <= 8)?.name ??
          null;
        const loadedSelected = mergedSchema
          .filter((v) => v.role !== "id" && v.type !== "text" && v.name !== groupCol)
          .map((v) => v.name);
        setSlides([makeSlide({
          id: "s1",
          group: groupCol,
          selected: loadedSelected,
          settings: { ...DEFAULT_SETTINGS, ...(saved.table_settings as Partial<TableEditorSettings>) },
          analysis: (saved.last_analysis as import("./types").TableOneAnalysis) ?? null,
        })]);
      }
      setCurrentIndex(0);
      setProjectName(saved.project_name);
      skipNextAutoSave.current = true;
      setCurrentProjectId(saved.project_id);
      setSaveStatus("saved");
      const hasAny = saved.slides?.some((s) => s.analysis) || !!saved.last_analysis;
      setPage(preferredPage ?? (hasAny ? "table" : "dataset"));
      setNotice(`Проект «${saved.project_name}» загружен`);
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось загрузить проект");
      return false;
    } finally { setBusy(""); }
  };

  const runAnalysis = useCallback(async () => {
    if (!dataset) return;
    const targetIndex = currentIndex;
    const s = slides[targetIndex];
    const vars = s.selected.filter((n) => schema.some((v) => v.name === n));
    if (!vars.length) return;
    setBusy("Считаю…");
    try {
      const result = await api.tableOne(dataset.rows, s.group, vars, {
        numericPresentation: s.settings.numericPresentation,
        numericTest: s.settings.numericTest,
        categoricalTest: s.settings.categoricalTest,
        confidenceLevel: s.settings.confidenceLevel,
      }, Object.fromEntries(schema.map((v) => [v.name, v])));
      patchSlide(targetIndex, { analysis: result });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Ошибка расчёта");
    } finally { setBusy(""); }
  }, [dataset, currentIndex, slides, schema]);

  // Sync page/project → URL so refresh and sharing links work
  useEffect(() => {
    if (restoring) return;
    const target = page === "home" ? "/" :
      currentProjectId ? `/project/${encodeURIComponent(currentProjectId)}/${page}` : "/";
    if (location.pathname !== target) navigate(target, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, currentProjectId, restoring]);

  // keep a ref to always-fresh runAnalysis to avoid stale closures in the timer
  const runAnalysisRef = useRef(runAnalysis);
  useEffect(() => { runAnalysisRef.current = runAnalysis; }, [runAnalysis]);

  const analysisTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!dataset || !selected.length) return;
    clearTimeout(analysisTimer.current);
    analysisTimer.current = setTimeout(() => runAnalysisRef.current(), 700);
    return () => clearTimeout(analysisTimer.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, group,
      slide.settings.numericPresentation, slide.settings.numericTest,
      slide.settings.categoricalTest, slide.settings.confidenceLevel]);

  const buildSavePayload = useCallback((name: string, pid?: string) => ({
    ...(pid ? { project_id: pid } : {}),
    project_name: name,
    file_name: dataset!.file_name,
    rows: dataset!.rows,
    variable_overrides: Object.fromEntries(schema.map((item) => [item.name, item])),
    slides: slides.map((s) => ({
      id: s.id,
      group: s.group,
      selected: s.selected,
      settings: s.settings,
      analysis: s.analysis,
    })),
    regression,
    // backward compat fields
    last_analysis: slides[0]?.analysis ?? null,
    table_settings: slides[0]?.settings ?? {},
  }), [dataset, schema, slides, regression]);

  // silent auto-save to existing project
  const silentSave = useCallback(async (pid: string) => {
    if (!dataset) return;
    setSaveStatus("saving");
    try {
      await api.saveProject(buildSavePayload(projectName, pid));
      setSaveStatus("saved");
      refreshProjects();
    } catch {
      setSaveStatus("dirty");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, projectName, buildSavePayload]);

  // auto-save effect: fires 3s after any change if project already has an ID
  useEffect(() => {
    if (!dataset || !currentProjectId) { if (dataset) setSaveStatus("dirty"); return; }
    if (skipNextAutoSave.current) { skipNextAutoSave.current = false; return; }
    setSaveStatus("dirty");
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => silentSave(currentProjectId), 3000);
    return () => clearTimeout(autoSaveTimer.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, schema, slides, regression, projectName]);

  // Keep an unsaved imported workspace locally so a browser refresh cannot replace it.
  useEffect(() => {
    if (restoring) return;
    clearTimeout(draftSaveTimer.current);
    if (!dataset || currentProjectId) {
      if (currentProjectId) clearWorkspaceDraft().catch(() => {});
      return;
    }
    draftSaveTimer.current = setTimeout(() => {
      saveWorkspaceDraft<WorkspaceDraft>({ dataset, schema, slides, currentIndex, projectName, page, regression }).catch(() => {});
    }, 500);
    return () => clearTimeout(draftSaveTimer.current);
  }, [dataset, schema, slides, currentIndex, projectName, page, regression, currentProjectId, restoring]);

  const deleteProject = async (projectId: string, projectNameLabel: string) => {
    if (!window.confirm(`Удалить проект «${projectNameLabel}»? Это действие нельзя отменить.`)) return;
    try {
      await api.deleteProject(projectId);
      if (currentProjectId === projectId) {
        setCurrentProjectId(null);
        setSaveStatus("dirty");
      }
      refreshProjects();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось удалить проект");
    }
  };

  // explicit "Save As" — creates a new project file
  const saveAs = async (name: string) => {
    if (!dataset || !name.trim()) return;
    setBusy("Сохраняю…");
    try {
      const result = await api.saveProject(buildSavePayload(name.trim()));
      setCurrentProjectId(result.project_id);
      setProjectName(name.trim());
      setSaveStatus("saved");
      refreshProjects();
      setNotice("Проект сохранён");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally { setBusy(""); }
  };

  const applyGroupSlots = (analysis: import("./types").TableOneAnalysis, slots: GroupSlot[]): import("./types").TableOneAnalysis => {
    if (!slots.length || slots.length !== analysis.groups.length) return analysis;
    return {
      ...analysis,
      groups: slots.map(slot => ({ name: slot.label, n: analysis.groups.find(g => g.name === slot.rawValue)?.n ?? 0 })),
      rows: analysis.rows.map(row => ({
        ...row,
        groups: Object.fromEntries(slots.map(s => [s.label, row.groups[s.rawValue] ?? "—"])),
        levels: row.levels.map(lv => ({ ...lv, groups: Object.fromEntries(slots.map(s => [s.label, lv.groups[s.rawValue] ?? "—"])) })),
      })),
    };
  };

  const buildExportOptions = (s: TableSlide, selectedNames: string[], slideNum: number): ExportOptions => {
    const labelMap = Object.fromEntries(schema.map((v) => [v.name, v.label]));
    const d = s.settings.decimals;
    const pf = s.settings.pFormat;
    const fmt = (v: string) =>
      v.replace(/-?\d+[.,]\d+/g, (n) => Number(n.replace(",", ".")).toFixed(d).replace(".", ","));
    const fmtp = (row: AnalysisRow) => {
      if (pf === "exact" || row.p_value === null) return row.p_display;
      return row.p_value < 0.001 ? "<0,001" : row.p_value < 0.05 ? "<0,05" : "≥0,05";
    };
    return {
      title: formatTableCaption(s.settings.title, slideNum),
      description: s.settings.description,
      footnotes: s.settings.footnotes,
      showOverall: s.settings.showOverall,
      showEffect: s.settings.showEffect,
      showCI: s.settings.showCI,
      showMissing: s.settings.showMissing,
      decomposeCategories: true,
      analysis: (() => {
        const base = applyGroupSlots(s.analysis!, s.groupSlots);
        return {
          ...base,
          rows: selectedNames
            .map((name) => base.rows.find((r) => r.variable === name))
            .filter((r): r is AnalysisRow => Boolean(r))
            .map((row) => ({
              ...row,
              label: labelMap[row.variable] || row.variable,
              overall: fmt(row.overall),
              groups: Object.fromEntries(Object.entries(row.groups).map(([k, v]) => [k, fmt(v)])),
              p_display: fmtp(row),
            })),
        };
      })(),
    };
  };

  const exportDocx = async () => {
    if (!analysis) return;
    setBusy("Формирую DOCX…");
    try {
      download(await api.exportDocx(buildExportOptions(slide, selected, currentIndex + 1)), "table-one.docx");
      setNotice("DOCX сформирован");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Ошибка экспорта");
    } finally { setBusy(""); }
  };

  const exportReport = async () => {
    const computed = slides.map((s, idx) => ({ s, idx })).filter(({ s }) => s.analysis !== null);
    const hasCorr = correlation.result && (correlation.includeMatrix || correlation.reportPairs.length > 0);
    if (!computed.length && !regression.result && !hasCorr) { setNotice("Нет рассчитанных результатов для экспорта"); return; }
    setBusy("Собираю отчёт…");
    try {
      const tables: ExportOptions[] = computed.map(({ s, idx }) => buildExportOptions(s, s.selected, idx + 1));
      const regressionExport = regression.result ? {
        analysis: regression.result, cutoff: regression.cutoff,
        labels: Object.fromEntries(schema.map((v) => [v.name, v.label])),
      } : undefined;
      const correlationExport = hasCorr && correlation.result ? {
        result: correlation.result,
        include_matrix: correlation.includeMatrix,
        pairs: correlation.reportPairs.map((p) => {
          const xSch = schema.find((s) => s.name === p.col);
          const ySch = schema.find((s) => s.name === p.row);
          return {
            row: p.row, col: p.col,
            x_label: xSch?.label ?? p.col,
            y_label: ySch?.label ?? p.row,
            x_values: dataset!.rows.map((r) => { const v = r[p.col]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; }),
            y_values: dataset!.rows.map((r) => { const v = r[p.row]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; }),
          };
        }),
      } : undefined;
      download(await api.exportReport(tables, regressionExport, correlationExport), "report.docx");
      setNotice("Единый отчёт сформирован");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Ошибка экспорта отчёта");
    } finally { setBusy(""); }
  };

  const updateVariable = (name: string, patch: Partial<VariableSchema>) =>
    setSchema((cur) => cur.map((item) => item.name === name ? { ...item, ...patch } : item));

  if (restoring) return (
    <div className="restore-screen">
      <div className="restore-spinner" />
      <p>Загрузка…</p>
    </div>
  );

  return (
    <div className={`app-shell${page === "home" ? " home-mode" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><ArgusMark /><div><strong>Argus</strong><small>Видеть больше в данных</small></div></div>
        <nav aria-label="Модули анализа">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`${page === item.id ? "active" : ""} ${!item.enabled ? "disabled" : ""}`}
              disabled={!item.enabled}
              onClick={() => item.enabled && setPage(item.id as Page)}
            >
              <span className="nav-mark" aria-hidden="true">{item.mark}</span><span>{item.label}</span>
              {!item.enabled && <span className="soon">скоро</span>}
            </button>
          ))}
        </nav>
        <div className="privacy-note"><span>●</span><div><strong>Локальная обработка</strong><small>Данные не уходят во внешние сервисы</small></div></div>
      </aside>

      <main>
        <header className="topbar">
          <button className="topbar-home-btn" onClick={() => setPage("home")} title="На главную">
            <ArgusMark className="argus-mark--topbar" />
          </button>
          <div className="project-title">
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)} aria-label="Название проекта" />
          </div>
          <div className="top-actions">
            <span className="dataset-chip">{dataset ? `${dataset.row_count} × ${dataset.column_count}` : "Нет данных"}</span>
            {dataset && currentProjectId ? (
              <span className={`save-status save-status--${saveStatus}`}>
                {saveStatus === "saving" ? "⟳ Сохраняется…" : saveStatus === "saved" ? "✓ Сохранено" : "● Не сохранено"}
                <button className="save-as-link" title="Сохранить копию под новым именем" onClick={() => { setSaveAsName(projectName); setSaveAsOpen(true); }}>Копия</button>
              </span>
            ) : dataset ? (
              <button className="button secondary" onClick={() => { setSaveAsName(projectName); setSaveAsOpen(true); }} disabled={!!busy}>Сохранить</button>
            ) : null}
          </div>
        </header>

        <div className="workspace">
          {page === "home" && (
            <HomePage
              savedProjects={savedProjects}
              onImport={() => inputRef.current?.click()}
              onDemo={loadDemo}
              onLoadProject={loadProject}
              onDeleteProject={deleteProject}
              hasData={!!dataset}
              onContinue={() => setPage(dataset ? "dataset" : "home")}
            />
          )}
          {page === "dataset" && dataset && (
            <DatasetPage
              dataset={dataset}
              onUpload={() => inputRef.current?.click()}
              onOpenVariables={() => setPage("variables")}
              onEditCell={(rowIdx, col, value) =>
                setDataset((prev) => prev ? { ...prev, rows: prev.rows.map((r, i) => i === rowIdx ? { ...r, [col]: value } : r) } : null)
              }
            />
          )}
          {page === "variables" && dataset && (
            <VariablesPage schema={schema} onUpdate={updateVariable} onContinue={() => setPage("table")} />
          )}
          {page === "table" && dataset && (
            <TablePage
              dataset={dataset}
              schema={schema}
              candidateGroups={candidateGroups}
              group={group}
              setGroup={setGroup}
              groupSlots={slide.groupSlots}
              setGroupSlots={setGroupSlots}
              selected={selected}
              setSelected={setSelected}
              analysis={analysis}
              settings={tableSettings}
              setSettings={setTableSettings}
              onExport={exportDocx}
              onExportReport={exportReport}
              slideIndex={currentIndex}
              slideCount={slides.length}
              computedCount={slides.filter((s) => s.analysis !== null).length}
              onPrevSlide={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              onNextSlide={() => setCurrentIndex((i) => Math.min(slides.length - 1, i + 1))}
              onAddSlide={addSlide}
              onDeleteSlide={deleteCurrentSlide}
            />
          )}
          {page === "regression" && dataset && (
            <LogisticTablePage dataset={dataset} schema={schema} workspace={logisticTable} setWorkspace={setLogisticTable} />
          )}
          {page === "modeling" && dataset && (
            <RegressionPage dataset={dataset} schema={schema} workspace={regression} setWorkspace={setRegression} onOpenReport={() => setPage("report")} />
          )}
          {page === "correlation" && dataset && (
            <CorrelationPage dataset={dataset} schema={schema} workspace={correlation} setWorkspace={setCorrelation} />
          )}
          {page === "report" && dataset && (
            <ReportPreviewPage slides={slides} schema={schema} dataset={dataset} regression={regression} correlation={correlation} setCorrelation={setCorrelation} onExport={exportReport} />
          )}
        </div>
      </main>

      <input ref={inputRef} hidden type="file" accept=".csv,.xlsx" onChange={(e) => upload(e.target.files?.[0])} />
      {busy && <div className="busy"><span className="spinner" />{busy}</div>}
      {notice && <button className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}

      {saveAsOpen && (
        <div className="modal-overlay" onClick={() => setSaveAsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Сохранить как</h3>
            <input
              className="modal-input"
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && saveAsName.trim()) { saveAs(saveAsName); setSaveAsOpen(false); } if (e.key === "Escape") setSaveAsOpen(false); }}
              placeholder="Название проекта"
              autoFocus
            />
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setSaveAsOpen(false)}>Отмена</button>
              <button className="button primary" disabled={!saveAsName.trim()} onClick={() => { saveAs(saveAsName); setSaveAsOpen(false); }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
