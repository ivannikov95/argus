import { Fragment, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { ExportOptions, ProjectMeta } from "./api";
import type { AnalysisRow, CorrelationAnalysis, Dataset, RegressionAnalysis, TableOneAnalysis, VariableSchema } from "./types";
import { clearWorkspaceDraft, loadWorkspaceDraft, saveWorkspaceDraft } from "./draftStore";

// One independent table page in the multi-table report
interface TableSlide {
  id: string;
  group: string | null;
  selected: string[];
  settings: TableEditorSettings;
  analysis: TableOneAnalysis | null;
}

type Page = "home" | "dataset" | "variables" | "table" | "regression" | "correlation" | "report";

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

interface TableEditorSettings {
  title: string;
  description: string;
  footnotes: string;
  font: "times";
  fontSize: 10 | 11 | 12;
  alignment: "left" | "center" | "right";
  decimals: number;
  pFormat: "exact" | "threshold";
  showEffect: boolean;
  showOverall: boolean;
  showCI: boolean;
  showMissing: boolean;
  decomposeCategories: boolean;
  numericPresentation: "auto" | "mean_sd" | "median_iqr";
  numericTest: "auto" | "parametric" | "nonparametric";
  categoricalTest: "auto" | "chi_square" | "fisher";
  confidenceLevel: 0.90 | 0.95 | 0.99;
}

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

interface CorrelationWorkspace {
  variables: string[];
  method: "auto" | "pearson" | "spearman";
  result: CorrelationAnalysis | null;
  includeMatrix: boolean;
  reportPairs: { row: string; col: string }[];
}

interface RegressionWorkspace {
  outcome: string;
  predictors: string[];
  confidenceLevel: number;
  cutoff: number;
  result: RegressionAnalysis | null;
}

const DEFAULT_SETTINGS: TableEditorSettings = {
  title: "Таблица 1 - Базовые характеристики исследуемой выборки",
  description: "",
  footnotes: "",
  font: "times",
  fontSize: 11,
  alignment: "left",
  decimals: 1,
  pFormat: "exact",
  showOverall: true,
  showEffect: true,
  showCI: true,
  showMissing: true,
  decomposeCategories: false,
  numericPresentation: "auto",
  numericTest: "auto",
  categoricalTest: "auto",
  confidenceLevel: 0.95,
};

const nav: { id: Page | string; label: string; mark: string; enabled: boolean }[] = [
  { id: "home", label: "Главная", mark: "◎", enabled: true },
  { id: "dataset", label: "Датасет", mark: "▦", enabled: true },
  { id: "variables", label: "Переменные", mark: "≡", enabled: true },
  { id: "table", label: "Описательная статистика", mark: "▥", enabled: true },
  { id: "regression", label: "Регрессия", mark: "∑", enabled: true },
  { id: "report", label: "Отчёт", mark: "▤", enabled: true },
  { id: "correlation", label: "Корреляции", mark: "⌁", enabled: true },
  { id: "survival", label: "Выживаемость", mark: "◷", enabled: false },
];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function formatTableCaption(value: string, num = 1) {
  const title = value.trim();
  if (!title) return `Таблица ${num} - Без названия`;
  if (/^Таблица\s+\d+\s*[-–—]/i.test(title)) return title.replace(/^(Таблица\s+\d+)\s*[-–—]\s*/i, "$1 - ");
  return `Таблица ${num} - ${title}`;
}

function makeSlide(overrides: Partial<TableSlide> & { id: string }): TableSlide {
  return { group: null, selected: [], settings: { ...DEFAULT_SETTINGS }, analysis: null, ...overrides };
}

function slidesForDataset(dataset: Dataset) {
  const suggestedGroup =
    dataset.schema.find((v) => v.name.toLowerCase().includes("group") && v.unique <= 8)?.name ??
    dataset.schema.find((v) => ["binary", "categorical"].includes(v.type) && v.role !== "id" && v.unique <= 8)?.name ??
    null;
  return [makeSlide({ id: "s1", group: suggestedGroup })];
}

function regressionForDataset(dataset: Dataset): RegressionWorkspace {
  const eligible = dataset.schema.filter((v) => v.role !== "id" && (v.type === "numeric" || v.type === "binary"));
  return {
    outcome: eligible.find((v) => v.role === "outcome")?.name ?? eligible.find((v) => v.type === "binary")?.name ?? eligible[0]?.name ?? "",
    predictors: [],
    confidenceLevel: 0.95,
    cutoff: 0.5,
    result: null,
  };
}

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

  const setGroup = (v: string | null) => updateSlide({ group: v, analysis: null });
  const setSelected = (v: string[]) => updateSlide({ selected: v });
  const setTableSettings = (v: TableEditorSettings) => updateSlide({ settings: v });

  const addSlide = () => {
    const num = slides.length + 1;
    const baseTitle = slide.settings.title.replace(/^Таблица\s+\d+\s*[-–—]\s*/i, "").trim();
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
          analysis: (s.analysis as TableOneAnalysis) ?? null,
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
          analysis: (saved.last_analysis as TableOneAnalysis) ?? null,
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
      analysis: {
        ...s.analysis!,
        rows: selectedNames
          .map((name) => s.analysis!.rows.find((r) => r.variable === name))
          .filter((r): r is AnalysisRow => Boolean(r))
          .map((row) => ({
            ...row,
            label: labelMap[row.variable] || row.variable,
            overall: fmt(row.overall),
            groups: Object.fromEntries(Object.entries(row.groups).map(([k, v]) => [k, fmt(v)])),
            p_display: fmtp(row),
          })),
      },
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

const CARD_GRADIENTS = [
  "linear-gradient(135deg,#0d47a1,#1565c0,#1976d2)",
  "linear-gradient(135deg,#1b5e20,#2e7d32,#43a047)",
  "linear-gradient(135deg,#4a148c,#6a1b9a,#8e24aa)",
  "linear-gradient(135deg,#b71c1c,#c62828,#e53935)",
  "linear-gradient(135deg,#e65100,#ef6c00,#fb8c00)",
  "linear-gradient(135deg,#004d40,#00695c,#00897b)",
];

const HV_ROWS = [
  ["Возраст, M ± SD", "63,5 ± 9,8", "62,4 ± 9,6", "64,7 ± 9,9", "0,203"],
  ["Пол (муж.), n (%)", "38 (63%)", "19 (63%)", "19 (63%)", "1,000"],
  ["ЦРБ, Me [Q1;Q3]", "4,2 [2,1;8,6]", "4,1 [2,0;8,4]", "4,3 [2,2;8,8]", "0,841"],
  ["ФВЛЖ, M ± SD", "52,3 ± 8,1", "53,1 ± 7,9", "51,4 ± 8,4", "0,047"],
];

function HomePage({ savedProjects, onImport, onDemo, onLoadProject, onDeleteProject, hasData, onContinue }: {
  savedProjects: ProjectMeta[]; onImport: () => void; onDemo: () => void;
  onLoadProject: (id: string) => void; onDeleteProject: (id: string, name: string) => void;
  hasData: boolean; onContinue: () => void;
}) {
  return (
    <section className="home-page">
      {/* Sticky top nav */}
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand">
            <ArgusMark className="argus-mark--header" />
            <div><strong>Argus</strong><small>Видеть больше в данных</small></div>
          </div>
          <div className="home-nav-actions">
            {hasData && <button className="home-nav-btn" onClick={onContinue}>Продолжить работу →</button>}
            <button className="home-nav-btn" onClick={onImport}>Импорт данных</button>
            <button className="home-nav-btn-primary" onClick={onDemo}>Демо-данные</button>
          </div>
        </div>
      </header>

      {/* Full-width hero */}
      <div className="home-hero">
        <div className="home-hero-inner">
          <div className="home-hero-content">
            <div className="home-hero-eyebrow"><ArgusMark className="argus-mark--hero" /> ARGUS · MEDICAL STATISTICS</div>
            <h1>Воспроизводимая<br/>медицинская<br/>статистика</h1>
            <p>Автоматический выбор критерия, Table 1 по стандартам публикаций, экспорт DOCX — без написания кода.</p>
            <div className="home-hero-btns">
              <button className="home-btn-primary" onClick={onImport}>Импорт CSV / XLSX</button>
              <button className="home-btn-secondary" onClick={onDemo}>Попробовать демо</button>
            </div>
            <div className="home-hero-stats">
              <div className="hstat"><span>t-Welch</span><small>/ Mann–Whitney</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>χ²</span><small>/ Fisher</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>Cohen's d</span><small>размер эффекта</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>DOCX</span><small>публикационный стиль</small></div>
            </div>
          </div>

          <div className="home-hero-visual" aria-hidden="true">
            <div className="hv-label">ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР</div>
            <div className="hv-card">
              <div className="hv-card-title">Таблица 1 — Клинические характеристики</div>
              <div className="hv-grid">
                {["Показатель","Все (n=60)","Группа А (n=30)","Группа Б (n=30)","p"].map((h,i) =>
                  <div key={h} className={`hv-th${i===0?" hv-th-first":""}`}>{h}</div>)}
                {HV_ROWS.map((row, ri) =>
                  row.map((cell, ci) => (
                    <div key={`${ri}-${ci}`} className={`hv-td${ci===0?" hv-td-first":""}${ci===4&&(ri===0||ri===3)?" hv-p-sig":""}`}>{cell}</div>
                  ))
                )}
              </div>
              <div className="hv-footer">
                <span>M ± SD — среднее ± стандартное отклонение; Me [Q1;Q3] — медиана с квартилями</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content sections */}
      <div className="home-inner">
        {savedProjects.length > 0 && (
          <div className="home-section">
            <div className="home-section-head">
              <h2>Последние проекты</h2>
              <span className="count-badge">{savedProjects.length}</span>
            </div>
            <div className="home-projects-grid">
              {savedProjects.map((p, i) => (
                <div key={p.project_id} className="project-card-wrap">
                  <button className="project-card" onClick={() => onLoadProject(p.project_id)}>
                    <div className="project-card-thumb" style={{ background: CARD_GRADIENTS[i % CARD_GRADIENTS.length] }}>
                      <span className="project-card-initial">{p.project_name.charAt(0).toUpperCase()}</span>
                    </div>
                    <div className="project-card-body">
                      <strong>{p.project_name}</strong>
                      <span>{p.file_name}</span>
                      <small>{new Date(p.saved_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</small>
                    </div>
                  </button>
                  <button
                    className="project-card-delete"
                    title="Удалить проект"
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p.project_id, p.project_name); }}
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="home-section">
          <div className="home-section-head"><h2>Возможности</h2></div>
          <div className="home-features">
            {[
              { icon: "▥", title: "Table 1 — автоматически", text: "Shapiro-Wilk → t-Welch или Mann–Whitney. χ² / Fisher для категорий. Cohen's d, Cramér's V, OR с 95% ДИ." },
              { icon: "⊞", title: "Многотабличный DOCX", text: "Несколько независимых таблиц с разными переменными — в один отчёт с разрывами страниц, Times New Roman." },
              { icon: "≡", title: "Словарь переменных", text: "Кастомные подписи, типы, роли переменных. Все решения прозрачны и остаются с проектом." },
              { icon: "⊙", title: "Локальная обработка", text: "Данные не покидают ваш компьютер. Никаких внешних API, облаков и третьих сторон." },
            ].map(({ icon, title, text }) => (
              <div key={title} className="feature-card">
                <div className="feature-icon">{icon}</div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const DS_PAGE_SIZE = 50;

function DatasetPage({ dataset, onUpload, onOpenVariables, onEditCell }: {
  dataset: Dataset; onUpload: () => void; onOpenVariables: () => void;
  onEditCell: (rowIdx: number, col: string, value: string) => void;
}) {
  const missingPercent = dataset.row_count * dataset.column_count
    ? dataset.missing_count / (dataset.row_count * dataset.column_count) * 100 : 0;
  const [dsPage, setDsPage] = useState(0);
  const [editing, setEditing] = useState<{ row: number; col: string; value: string } | null>(null);

  const totalPages = Math.ceil(dataset.row_count / DS_PAGE_SIZE);
  const pageRows = dataset.rows.slice(dsPage * DS_PAGE_SIZE, (dsPage + 1) * DS_PAGE_SIZE);
  const firstRowIdx = dsPage * DS_PAGE_SIZE;

  const commitEdit = () => {
    if (!editing) return;
    onEditCell(editing.row, editing.col, editing.value);
    setEditing(null);
  };

  return (
    <section className="page">
      <div className="page-heading">
        <div><span className="eyebrow">01 · Подготовка данных</span><h1>Датасет</h1><p>Проверка структуры до любых статистических решений.</p></div>
        <button className="button secondary" onClick={onUpload}>Импорт CSV / XLSX</button>
      </div>
      <div className="quality-grid">
        <article><span>Наблюдения</span><strong>{dataset.row_count}</strong><small>строк в активном листе</small></article>
        <article><span>Переменные</span><strong>{dataset.column_count}</strong><small>{dataset.schema.filter((v) => v.type === "numeric").length} числовых</small></article>
        <article className={dataset.missing_count ? "warning" : "success"}><span>Пропуски</span><strong>{dataset.missing_count}</strong><small>{missingPercent.toFixed(2)}% всех ячеек</small></article>
        <article className={dataset.duplicate_count ? "warning" : "success"}><span>Дубликаты</span><strong>{dataset.duplicate_count}</strong><small>полностью совпавших строк</small></article>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div><h2>{dataset.file_name}</h2><p>Кликните на ячейку для редактирования · Enter — подтвердить, Esc — отмена</p></div>
          <span className="status-ok">● Данные готовы</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="ds-row-num">#</th>
                {dataset.schema.map((v) => <th key={v.name}>{v.name}<small>{v.type}</small></th>)}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, ri) => {
                const absIdx = firstRowIdx + ri;
                return (
                  <tr key={absIdx}>
                    <td className="ds-row-num">{absIdx + 1}</td>
                    {dataset.schema.map((v) => {
                      const isEditing = editing?.row === absIdx && editing?.col === v.name;
                      return (
                        <td
                          key={v.name}
                          className={`ds-cell${isEditing ? " ds-cell--editing" : ""}`}
                          onClick={() => { if (!isEditing) setEditing({ row: absIdx, col: v.name, value: String(row[v.name] ?? "") }); }}
                        >
                          {isEditing ? (
                            <input
                              className="ds-cell-input"
                              value={editing.value}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                              onBlur={commitEdit}
                              onKeyDown={(e) => { if (e.key === "Enter") { commitEdit(); } if (e.key === "Escape") setEditing(null); }}
                              autoFocus
                            />
                          ) : (
                            <span className={row[v.name] == null || row[v.name] === "" ? "ds-null" : ""}>{formatValue(row[v.name])}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>{firstRowIdx + 1}–{Math.min(firstRowIdx + DS_PAGE_SIZE, dataset.row_count)} из {dataset.row_count} строк</span>
          <div className="ds-pagination">
            <button className="button secondary" onClick={() => setDsPage(0)} disabled={dsPage === 0}>«</button>
            <button className="button secondary" onClick={() => setDsPage((p) => p - 1)} disabled={dsPage === 0}>‹</button>
            <span>стр. {dsPage + 1} / {totalPages}</span>
            <button className="button secondary" onClick={() => setDsPage((p) => p + 1)} disabled={dsPage >= totalPages - 1}>›</button>
            <button className="button secondary" onClick={() => setDsPage(totalPages - 1)} disabled={dsPage >= totalPages - 1}>»</button>
          </div>
          <button className="text-button" onClick={onOpenVariables}>Проверить словарь переменных →</button>
        </div>
      </div>
    </section>
  );
}

function VariablesPage({ schema, onUpdate, onContinue }: { schema: VariableSchema[]; onUpdate: (name: string, patch: Partial<VariableSchema>) => void; onContinue: () => void }) {
  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">02 · Словарь данных</span><h1>Переменные</h1><p>Подтвердите семантику: укажите правильный тип и роль каждой переменной перед анализом.</p></div><button className="button primary" onClick={onContinue}>Перейти к Table 1</button></div>
      <div className="panel variable-panel">
        <div className="variable-head variable-row"><span>Имя и подпись</span><span>Тип</span><span>Роль</span><span>Пропуски</span><span>Уникальных</span></div>
        {schema.map((item) => (
          <div className="variable-row" key={item.name}>
            <div><code>{item.name}</code><input value={item.label} onChange={(e) => onUpdate(item.name, { label: e.target.value })} aria-label={`Подпись ${item.name}`} /></div>
            <select value={item.type} onChange={(e) => onUpdate(item.name, { type: e.target.value as VariableSchema["type"] })}><option value="numeric">Числовая</option><option value="categorical">Категориальная</option><option value="binary">Бинарная</option><option value="text">Текст</option></select>
            <select value={item.role} onChange={(e) => onUpdate(item.name, { role: e.target.value as VariableSchema["role"] })}><option value="feature">Предиктор</option><option value="group">Группа</option><option value="outcome">Исход</option><option value="id">ID</option></select>
            <span className={item.missing ? "bad-value" : "muted-value"}>{item.missing} ({item.missing_percent}%)</span><span>{item.unique}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TablePage({
  dataset, schema, candidateGroups, group, setGroup, selected, setSelected,
  analysis, settings, setSettings, onExport, onExportReport,
  slideIndex, slideCount, computedCount, onPrevSlide, onNextSlide, onAddSlide, onDeleteSlide,
}: {
  dataset: Dataset; schema: VariableSchema[]; candidateGroups: VariableSchema[];
  group: string | null; setGroup: (v: string | null) => void;
  selected: string[]; setSelected: (v: string[]) => void;
  analysis: TableOneAnalysis | null; settings: TableEditorSettings;
  setSettings: (s: TableEditorSettings) => void;
  onExport: () => void; onExportReport: () => void;
  slideIndex: number; slideCount: number; computedCount: number;
  onPrevSlide: () => void; onNextSlide: () => void; onAddSlide: () => void; onDeleteSlide: () => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ name: string; edge: "before" | "after" } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number; width: number } | null>(null);
  const [pickerOrder, setPickerOrder] = useState<string[]>(() => schema.map((v) => v.name));
  const draggedRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ name: string; edge: "before" | "after" } | null>(null);
  const variableRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const labels = Object.fromEntries(schema.map((item) => [item.name, item.label]));
  const available = schema.filter((v) => v.role !== "id" && v.type !== "text" && v.name !== group);
  const availableNames = new Set(available.map((v) => v.name));
  const pickerVariables = [
    ...pickerOrder.map((name) => available.find((v) => v.name === name)).filter((v): v is VariableSchema => Boolean(v)),
    ...available.filter((v) => !pickerOrder.includes(v.name)),
  ];
  const visibleRows = selected
    .filter((name) => availableNames.has(name))
    .map((name) => analysis?.rows.find((row) => row.variable === name))
    .filter((row): row is AnalysisRow => Boolean(row));
  const ghostVariable = dragGhost ? available.find((v) => v.name === dragGhost.name) : null;

  const updateSettings = (patch: Partial<TableEditorSettings>) => setSettings({ ...settings, ...patch });
  const formatStat = (value: string) =>
    value.replace(/-?\d+[.,]\d+/g, (n) => Number(n.replace(",", ".")).toFixed(settings.decimals).replace(".", ","));
  const presShort = (p: string) =>
    p === "Среднее ± SD" ? "M ± SD" : p === "Медиана [Q1; Q3]" ? "Me [Q1; Q3]" : p;
  const formatP = (row: AnalysisRow) => {
    if (settings.pFormat === "exact" || row.p_value === null) return row.p_display;
    if (row.p_value < 0.001) return "<0,001";
    return row.p_value < 0.05 ? "<0,05" : "≥0,05";
  };

  const toggleVariable = (name: string) =>
    setSelected(selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name]);

  const movePickerVariable = (source: string, target: string, edge: "before" | "after") => {
    const next = pickerVariables.map((v) => v.name).filter((name) => name !== source);
    const targetIndex = next.indexOf(target);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
    setPickerOrder(next);
  };

  const moveVariable = (name: string, direction: -1 | 1) => {
    const index = selected.indexOf(name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(next);
    movePickerVariable(name, selected[target], direction < 0 ? "before" : "after");
  };

  const updateDropHint = (hint: { name: string; edge: "before" | "after" } | null) => {
    dropHintRef.current = hint; setDropHint(hint);
  };
  const clearPointerDrag = () => {
    draggedRef.current = null; setDragged(null); setDragGhost(null); updateDropHint(null);
  };
  const dropVariable = (source: string, target: string, edge: "before" | "after") => {
    if (source === target || !selected.includes(target)) return;
    const next = selected.filter((name) => name !== source);
    next.splice(next.indexOf(target) + (edge === "after" ? 1 : 0), 0, source);
    setSelected(next);
    movePickerVariable(source, target, edge);
  };
  const startPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, name: string) => {
    if (event.button !== 0 || !selected.includes(name)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = variableRefs.current[name]?.getBoundingClientRect();
    draggedRef.current = name; setDragged(name);
    setDragGhost({ name, x: event.clientX + 14, y: event.clientY + 14, width: Math.min(bounds?.width ?? 270, 280) });
    updateDropHint(null);
  };
  const movePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const source = draggedRef.current;
    if (!source) return;
    event.preventDefault();
    setDragGhost((g) => g ? { ...g, x: event.clientX + 14, y: event.clientY + 14 } : g);
    const candidates = selected.filter((name) => name !== source && variableRefs.current[name]);
    if (!candidates.length) return;
    let hint: { name: string; edge: "before" | "after" } | null = null;
    for (const name of candidates) {
      const bounds = variableRefs.current[name]!.getBoundingClientRect();
      if (event.clientY <= bounds.bottom) {
        hint = { name, edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" };
        break;
      }
    }
    if (!hint) hint = { name: candidates[candidates.length - 1], edge: "after" };
    const cur = dropHintRef.current;
    if (cur?.name !== hint.name || cur.edge !== hint.edge) updateDropHint(hint);
  };
  const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const source = draggedRef.current, hint = dropHintRef.current;
    if (source && hint) dropVariable(source, hint.name, hint.edge);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clearPointerDrag();
  };

  return (
    <section className="analysis-layout">
      <div className="analysis-main">
        <div className="page-heading compact">
          <div className="heading-title-wrap"><span className="eyebrow">03 · Описательная статистика</span><input className="heading-title-input" value={settings.title} onChange={(e) => updateSettings({ title: e.target.value })} onBlur={() => updateSettings({ title: formatTableCaption(settings.title, slideIndex + 1) })} aria-label="Заголовок таблицы" /><p>Представление, тест и размер эффекта фиксируются для каждой переменной.</p></div>
          <div className="slide-nav">
            <button className="slide-arrow" disabled={slideIndex === 0} onClick={onPrevSlide} title="Предыдущая таблица">←</button>
            <span className="slide-counter">{slideIndex + 1} / {slideCount}</span>
            <button className="slide-arrow" disabled={slideIndex === slideCount - 1} onClick={onNextSlide} title="Следующая таблица">→</button>
            <button className="button secondary" onClick={onAddSlide}>+ Таблица</button>
            {slideCount > 1 && <button className="button ghost-danger" onClick={onDeleteSlide} title="Удалить эту таблицу">×</button>}
            <button className="button secondary" onClick={onExport} disabled={!analysis}>Экспорт DOCX</button>
          </div>
        </div>

        {!analysis
          ? <div className="empty-analysis"><div className="empty-analysis-icon">☰</div><h2>Отметьте переменные справа</h2><p>Поставьте галочку рядом с нужными показателями — таблица рассчитается автоматически.</p></div>
          : (
            <div className={`paper table-font-${settings.font} table-size-${settings.fontSize} table-align-${settings.alignment}`}>
              <div className="paper-title">
                <input
                  className="paper-title-input"
                  value={settings.title}
                  onChange={(e) => updateSettings({ title: e.target.value })}
                  onBlur={() => updateSettings({ title: formatTableCaption(settings.title, slideIndex + 1) })}
                  aria-label="Заголовок таблицы"
                />
                <p>{settings.description || "Автоматически сформированный статистический черновик"}</p>
              </div>
              <div className="table-scroll"><table className="result-table"><thead><tr><th>Показатель</th>{settings.showOverall && <th>Все (n={analysis.n})</th>}{analysis.groups.map((g) => <th key={g.name}>{g.name}<small>n={g.n}</small></th>)}{settings.showMissing && <th>Пропуски</th>}{settings.showCI && <th>95% ДИ</th>}<th>p-value</th>{settings.showEffect && <th>Эффект</th>}</tr></thead><tbody>{visibleRows.map((row) => <Fragment key={row.variable}><tr><td><strong>{labels[row.variable] || row.variable}</strong><small>{presShort(row.presentation)}</small></td>{settings.showOverall && <td>{row.levels.length ? "" : formatStat(row.overall)}</td>}{analysis.groups.map((g) => <td key={g.name}>{row.levels.length ? "" : formatStat(row.groups[g.name])}</td>)}{settings.showMissing && <td>{row.missing}</td>}{settings.showCI && <td>{formatStat(row.ci_display)}<small>{row.ci_label}</small></td>}<td className={row.p_value !== null && row.p_value < 0.05 ? "significant" : ""}>{formatP(row)}</td>{settings.showEffect && <td>{formatStat(row.effect)}<small>{row.effect_label}</small></td>}</tr>{row.levels.map((level) => <tr className="category-level" key={`${row.variable}-${level.level}`}><td>↳ {level.level}</td>{settings.showOverall && <td>{formatStat(level.overall)}</td>}{analysis.groups.map((g) => <td key={g.name}>{formatStat(level.groups[g.name])}</td>)}{settings.showMissing && <td />}{settings.showCI && <td />}<td />{settings.showEffect && <td />}</tr>)}</Fragment>)}</tbody></table></div>
              {!visibleRows.length && <div className="no-rows">В таблице нет строк — выберите хотя бы одну переменную справа.</div>}
              <p className="analysis-note"><strong>Методическое примечание.</strong> {analysis.note} Пропуски исключались отдельно для каждой переменной.</p>
              {settings.footnotes && <p className="custom-footnotes">{settings.footnotes}</p>}
            </div>
          )
        }
      </div>

      <aside className="inspector">
        <div className="editor-title"><span className="eyebrow">Таблица {slideIndex + 1}</span><h2>Выбор переменных</h2></div>
        <label className="field"><span>Группирующая переменная</span><select value={group ?? ""} onChange={(e) => setGroup(e.target.value || null)}><option value="">Без группировки</option>{candidateGroups.map((v) => <option value={v.name} key={v.name}>{v.label} ({v.unique})</option>)}</select></label>
        <div className={`variable-picker ${dragged ? "is-reordering" : ""}`}>
          <div className="picker-head"><span>Переменные · {selected.filter((name) => availableNames.has(name)).length} выбрано</span><button onClick={() => setSelected(selected.filter((name) => availableNames.has(name)).length === available.length ? [] : available.map((v) => v.name))}>{selected.filter((name) => availableNames.has(name)).length === available.length ? "Снять все" : "Выбрать все"}</button></div>
          <p className="picker-hint">Отмечайте строки и перетаскивайте выбранные переменные за маркер.</p>
          {pickerVariables.map((variable) => {
            const isSelected = selected.includes(variable.name);
            const position = selected.indexOf(variable.name);
            const hintClass = dropHint?.name === variable.name && dragged !== variable.name ? `drop-${dropHint.edge}` : "";
            return (
              <div className={`variable-choice ${isSelected ? "selected" : ""} ${dragged === variable.name ? "dragging" : ""} ${hintClass}`} key={variable.name} ref={(el) => { variableRefs.current[variable.name] = el; }}>
                <button type="button" className="drag-handle" disabled={!isSelected} aria-label={`Перетащить ${variable.label}`} onPointerDown={(e) => startPointerDrag(e, variable.name)} onPointerMove={movePointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => clearPointerDrag()}>⠿</button>
                <label><input type="checkbox" checked={isSelected} onChange={() => toggleVariable(variable.name)} /><span>{variable.label}<small>{variable.type} · пропуски {variable.missing}</small></span></label>
                <div className="reorder-buttons">
                  <button disabled={!isSelected || position === 0} onClick={() => moveVariable(variable.name, -1)} aria-label={`Поднять ${variable.label}`}>↑</button>
                  <button disabled={!isSelected || position === selected.length - 1} onClick={() => moveVariable(variable.name, 1)} aria-label={`Опустить ${variable.label}`}>↓</button>
                </div>
              </div>
            );
          })}
        </div>
        <section className="editor-section compact-section">
          <h3>Статистика</h3>
          <label className="editor-check"><input type="checkbox" checked={settings.showOverall} onChange={(e) => updateSettings({ showOverall: e.target.checked })} /><span>Столбец «Все»</span></label>
          <label className="editor-check"><input type="checkbox" checked={settings.showCI} onChange={(e) => updateSettings({ showCI: e.target.checked })} /><span>95% ДИ</span></label>
          <label className="editor-check disabled-control" title="Проверка распределения обязательна для автоматического выбора метода"><input type="checkbox" checked disabled /><span>Тесты распределения</span></label>
          <label className="editor-check"><input type="checkbox" checked={settings.showEffect} onChange={(e) => updateSettings({ showEffect: e.target.checked })} /><span>Размер эффекта</span></label>
          <label className="editor-check"><input type="checkbox" checked={settings.showMissing} onChange={(e) => updateSettings({ showMissing: e.target.checked })} /><span>Число пропусков</span></label>
        </section>
        <section className="editor-section analysis-settings">
          <h3>Настройки статистического анализа</h3>
          <label className="field"><span>Непрерывные данные</span><select value={settings.numericPresentation} onChange={(e) => updateSettings({ numericPresentation: e.target.value as TableEditorSettings["numericPresentation"] })}><option value="auto">Авто: Mean или Median</option><option value="mean_sd">Mean ± SD</option><option value="median_iqr">Median [Q1; Q3]</option></select></label>
          <label className="field"><span>Критерий для непрерывных</span><select value={settings.numericTest} onChange={(e) => updateSettings({ numericTest: e.target.value as TableEditorSettings["numericTest"] })}><option value="auto">Автоопределение</option><option value="parametric">Welch / ANOVA Welch</option><option value="nonparametric">Mann–Whitney / Kruskal–Wallis</option></select></label>
          <label className="field"><span>Критерий для категориальных</span><select value={settings.categoricalTest} onChange={(e) => updateSettings({ categoricalTest: e.target.value as TableEditorSettings["categoricalTest"] })}><option value="auto">Авто: χ² или Fisher</option><option value="chi_square">χ² Пирсона</option><option value="fisher">Fisher для таблиц 2×2</option></select></label>
          <label className="field"><span>Уровень значимости (ДИ)</span><select value={settings.confidenceLevel} onChange={(e) => updateSettings({ confidenceLevel: Number(e.target.value) as TableEditorSettings["confidenceLevel"] })}><option value={0.90}>90%</option><option value={0.95}>95%</option><option value={0.99}>99%</option></select></label>
          <label className="editor-check disabled-control" title="Категории всегда выводятся отдельными строками"><input type="checkbox" checked disabled /><span>Категории отдельными строками</span></label>
          <small className="recalc-hint">Выбор критерия и уровня ДИ применяется после пересчёта.</small>
        </section>
        <div className="method-card"><strong>Автовыбор метода</strong><p>Непрерывные данные: Welch или Mann–Whitney. Категории: χ² или Fisher. Вместе с p показывается размер эффекта.</p></div>
        <section className="editor-section">
          <h3>Контент</h3>
          <input className="editor-input" value={settings.title} onChange={(e) => updateSettings({ title: e.target.value })} onBlur={() => updateSettings({ title: formatTableCaption(settings.title, slideIndex + 1) })} aria-label="Заголовок таблицы" />
          <textarea className="editor-input" value={settings.description} onChange={(e) => updateSettings({ description: e.target.value })} placeholder="Описание…" aria-label="Описание таблицы" />
          <textarea className="editor-input small" value={settings.footnotes} onChange={(e) => updateSettings({ footnotes: e.target.value })} placeholder="Сноски…" aria-label="Сноски таблицы" />
        </section>
        <section className="editor-section">
          <h3>Форматирование</h3>
          <div className="editor-grid two">
            <select value={settings.font} disabled aria-label="Шрифт таблицы"><option value="times">Times New Roman</option></select>
            <select value={settings.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) as TableEditorSettings["fontSize"] })} aria-label="Размер шрифта"><option value={10}>10 pt</option><option value={11}>11 pt</option><option value={12}>12 pt</option></select>
          </div>
          <div className="alignment-control" aria-label="Выравнивание">
            {(["left", "center", "right"] as const).map((a) => <button key={a} className={settings.alignment === a ? "active" : ""} aria-pressed={settings.alignment === a} onClick={() => updateSettings({ alignment: a })}>{a === "left" ? "≡" : a === "center" ? "☰" : "≣"}</button>)}
          </div>
          <label className="setting-row"><span>Знаки после запятой</span><input type="number" min={0} max={4} value={settings.decimals} onChange={(e) => updateSettings({ decimals: Math.min(4, Math.max(0, Number(e.target.value))) })} /></label>
          <label className="setting-row"><span>Формат p-value</span><select value={settings.pFormat} onChange={(e) => updateSettings({ pFormat: e.target.value as TableEditorSettings["pFormat"] })}><option value="exact">0,000</option><option value="threshold">&lt;0,05 / ≥0,05</option></select></label>
        </section>
        <section className="editor-section report-composer">
          <h3>Экспорт отчёта</h3>
          {computedCount > 0 ? (
            <>
              <p className="report-hint">Рассчитано: {computedCount} из {slideCount} {slideCount === 1 ? "таблицы" : slideCount < 5 ? "таблиц" : "таблиц"}</p>
              <button className="button primary wide" onClick={onExportReport}>
                Экспортировать отчёт ({computedCount})
              </button>
            </>
          ) : (
            <p className="report-hint">Рассчитайте хотя бы одну таблицу для экспорта.</p>
          )}
        </section>
        <small className="disclaimer">Результат предназначен для проверки исследователем и не является медицинским заключением.</small>
      </aside>

      {dragGhost && ghostVariable && createPortal(
        <div className="drag-preview" style={{ left: dragGhost.x, top: dragGhost.y, width: dragGhost.width }}>
          <span aria-hidden="true">⠿</span>
          <div><strong>{ghostVariable.label}</strong><small>{ghostVariable.type} · пропуски {ghostVariable.missing}</small></div>
        </div>,
        document.body,
      )}
    </section>
  );
}

// ─── Correlation heatmap color ───────────────────────────────────────────────
function corrDirection(r: number): string { return r >= 0 ? "Прямая" : "Обратная"; }
function corrStrengthWord(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.9) return "очень сильная";
  if (a >= 0.7) return "сильная";
  if (a >= 0.5) return "умеренная";
  if (a >= 0.3) return "слабая";
  return "очень слабая";
}
function formatPExact(p: number | null): string {
  if (p === null) return "—";
  if (p < 0.001) return "< 0,001";
  return p.toFixed(3).replace(".", ",");
}

function corrColor(r: number | null): string {
  if (r === null || isNaN(r)) return "#f0f2f5";
  const abs = Math.abs(r);
  return r >= 0
    ? `hsl(217,${Math.round(abs * 75)}%,${Math.round(100 - abs * 36)}%)`
    : `hsl(350,${Math.round(abs * 75)}%,${Math.round(100 - abs * 36)}%)`;
}

interface HoveredCell { row: string; col: string; rectRight: number; rectTop: number; }

function ScatterTooltip({ dataset, schema, labels, hovered, result, method }: {
  dataset: Dataset;
  schema: VariableSchema[];
  labels: Record<string, string>;
  hovered: HoveredCell;
  result: CorrelationAnalysis;
  method: string;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let url: string | null = null;
    setLoading(true); setImgUrl(null);

    const xValues = dataset.rows.map((r) => {
      const v = r[hovered.col];
      const n = typeof v === "string" ? parseFloat(v) : (v as number);
      return isNaN(n) ? null : n;
    });
    const yValues = dataset.rows.map((r) => {
      const v = r[hovered.row];
      const n = typeof v === "string" ? parseFloat(v) : (v as number);
      return isNaN(n) ? null : n;
    });

    const cell = result.matrix[hovered.row]?.[hovered.col];
    const xSchema = schema.find((s) => s.name === hovered.col);
    const ySchema = schema.find((s) => s.name === hovered.row);

    api.scatterUrl(
      xValues, yValues,
      xSchema?.label ?? labels[hovered.col] ?? hovered.col,
      ySchema?.label ?? labels[hovered.row] ?? hovered.row,
      cell?.r ?? null, cell?.stars ?? "", method,
    ).then((u) => {
      url = u;
      setImgUrl(u);
    }).catch(() => {}).finally(() => setLoading(false));

    return () => { if (url) URL.revokeObjectURL(url); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered.row, hovered.col]);

  const PANEL_W = 316, PANEL_H = 310;
  const vp = { w: window.innerWidth, h: window.innerHeight };
  const left = hovered.rectRight + 10 + PANEL_W > vp.w
    ? hovered.rectRight - PANEL_W - 70
    : hovered.rectRight + 10;
  const top = Math.min(Math.max(hovered.rectTop - 20, 8), vp.h - PANEL_H - 8);

  return createPortal(
    <div className="scatter-tooltip" style={{ left, top, width: PANEL_W }}>
      <div className="scatter-tip-header">
        <span className="scatter-tip-x">{labels[hovered.col] ?? hovered.col}</span>
        <span className="scatter-tip-vs">vs</span>
        <span className="scatter-tip-y">{labels[hovered.row] ?? hovered.row}</span>
      </div>
      <div className="scatter-tip-img-wrap">
        {loading && <div className="scatter-tip-spinner"><span className="spinner" /></div>}
        {imgUrl && <img src={imgUrl} className="scatter-tip-img" alt="scatter" />}
      </div>
    </div>,
    document.body,
  );
}

function CorrelationModal({ dataset, schema, labels, cell, result, inReport, onToggleReport, onClose }: {
  dataset: Dataset;
  schema: VariableSchema[];
  labels: Record<string, string>;
  cell: { row: string; col: string };
  result: CorrelationAnalysis;
  inReport: boolean;
  onToggleReport: () => void;
  onClose: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const corrCell = result.matrix[cell.row]?.[cell.col];
  const xLabel = schema.find((s) => s.name === cell.col)?.label ?? labels[cell.col] ?? cell.col;
  const yLabel = schema.find((s) => s.name === cell.row)?.label ?? labels[cell.row] ?? cell.row;
  const r = corrCell?.r ?? null;
  const p = corrCell?.p ?? null;
  const symbol = result.method === "pearson" ? "r" : "ρ";

  useEffect(() => {
    let url: string | null = null;
    const xValues = dataset.rows.map((row) => {
      const v = row[cell.col]; const n = typeof v === "string" ? parseFloat(v) : (v as number);
      return isNaN(n) ? null : n;
    });
    const yValues = dataset.rows.map((row) => {
      const v = row[cell.row]; const n = typeof v === "string" ? parseFloat(v) : (v as number);
      return isNaN(n) ? null : n;
    });
    api.scatterUrl(xValues, yValues, xLabel, yLabel, r, corrCell?.stars ?? "", result.method)
      .then((u) => { url = u; setImgUrl(u); })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => { if (url) URL.revokeObjectURL(url); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", handler); document.body.style.overflow = ""; };
  }, [onClose]);

  const download = () => {
    if (!imgUrl) return;
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = `correlation_${cell.col}_vs_${cell.row}.png`;
    a.click();
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="corr-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close-btn" onClick={onClose} aria-label="Закрыть">✕</button>
        <div className="corr-modal-img-col">
          {loading && <div className="corr-modal-spinner"><span className="spinner" /></div>}
          {imgUrl && <img src={imgUrl} className="corr-modal-img" alt="scatter plot" />}
        </div>
        <div className="corr-modal-info-col">
          <span className="corr-modal-badge">
            {result.method === "pearson" ? "Пирсон" : "Спирмен"} · n = {corrCell?.n ?? result.n}
          </span>
          {r !== null ? (
            <h2 className="corr-modal-title">
              {corrDirection(r)} {corrStrengthWord(r)} корреляционная взаимосвязь между «{xLabel}» и «{yLabel}»
            </h2>
          ) : (
            <h2 className="corr-modal-title">Нет данных для расчёта</h2>
          )}
          <div className="corr-modal-stats">
            <div className="corr-stat-row">
              <span className="corr-stat-label">Коэффициент {symbol}</span>
              <span className="corr-stat-value">
                {r !== null ? `${r.toFixed(3)} ${corrCell?.stars ?? ""}` : "—"}
              </span>
            </div>
            <div className="corr-stat-row">
              <span className="corr-stat-label">p-value</span>
              <span className="corr-stat-value">{formatPExact(p)}</span>
            </div>
          </div>
          <div className="corr-modal-actions">
            <button className={`corr-modal-report-btn${inReport ? " active" : ""}`} onClick={onToggleReport}>
              {inReport ? "✓ В отчёте" : "+ В отчёт"}
            </button>
            <button className="corr-modal-dl-btn" onClick={download} disabled={!imgUrl}>
              ↓ Скачать график
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CorrelationPage({ dataset, schema, workspace, setWorkspace }: {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: CorrelationWorkspace;
  setWorkspace: (w: CorrelationWorkspace | ((p: CorrelationWorkspace) => CorrelationWorkspace)) => void;
}) {
  const { variables, method, result } = workspace;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<HoveredCell | null>(null);
  const [modalCell, setModalCell] = useState<{ row: string; col: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const eligible = schema.filter((v) => v.role !== "id" && v.type !== "text");

  const toggle = (name: string) =>
    setWorkspace((p) => ({
      ...p,
      variables: p.variables.includes(name) ? p.variables.filter((v) => v !== name) : [...p.variables, name],
    }));

  const run = useCallback(async () => {
    if (variables.length < 2) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true); setError("");
    try {
      const res = await api.correlation(
        dataset.rows, variables,
        Object.fromEntries(schema.map((v) => [v.name, v])),
        method, ctrl.signal,
      );
      setWorkspace((p) => ({ ...p, result: res }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally { setBusy(false); }
  }, [dataset, variables, method, schema, setWorkspace]);

  useEffect(() => {
    if (variables.length < 2) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(run, 700);
    return () => clearTimeout(timerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, method]);

  const vars = result?.variables ?? [];
  const labels = result?.labels ?? {};
  const matrix = result?.matrix ?? {};

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">03 · Корреляционный анализ</span>
          <h1>Корреляции</h1>
          <p>Выберите переменные — матрица рассчитается автоматически.</p>
        </div>
        {result && (
          <button
            className={`corr-report-btn${workspace.includeMatrix ? " active" : ""}`}
            onClick={() => setWorkspace((p) => ({ ...p, includeMatrix: !p.includeMatrix }))}
          >
            {workspace.includeMatrix ? "✓ Матрица в отчёте" : "Добавить матрицу в отчёт"}
          </button>
        )}
      </div>
      <div className="analysis-layout">
        <div className="analysis-main">
          {busy && <div className="corr-busy"><span className="spinner" /> Считаю…</div>}
          {error && <div className="corr-error">{error}</div>}
          {!busy && result && (
            <div className="corr-wrap">
              <div className="corr-meta">
                <span>Метод: <strong>{result.method === "pearson" ? "Пирсон (r)" : "Спирмен (ρ)"}</strong></span>
                <span>N = {result.n}</span>
              </div>
              <div className="corr-scroll">
                <table className="corr-table">
                  <thead>
                    <tr>
                      <th />
                      {vars.map((v) => (
                        <th key={v}><span className="corr-colhead">{labels[v] ?? v}</span></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {vars.map((row) => (
                      <tr key={row}>
                        <td className="corr-rowlabel">{labels[row] ?? row}</td>
                        {vars.map((col) => {
                          const cell = matrix[row]?.[col];
                          const isDiag = row === col;
                          return (
                            <td
                              key={col}
                              className={`corr-cell${isDiag ? " corr-diag" : ""}${!isDiag ? " corr-hoverable" : ""}`}
                              style={{ background: isDiag ? "#eef2f7" : corrColor(cell?.r ?? null) }}
                              onMouseEnter={isDiag ? undefined : (e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHovered({ row, col, rectRight: rect.right, rectTop: rect.top });
                              }}
                              onMouseLeave={isDiag ? undefined : () => setHovered(null)}
                              onClick={isDiag ? undefined : () => setModalCell({ row, col })}
                            >
                              {isDiag ? <span className="corr-diag-dot">—</span> : cell?.r != null ? (
                                <><span className="corr-r">{cell.r.toFixed(2)}</span><span className="corr-stars">{cell.stars}</span></>
                              ) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="corr-legend">
                <span>* p&lt;0.05</span><span>** p&lt;0.01</span><span>*** p&lt;0.001</span>
                <div className="corr-scale">
                  <span>−1</span>
                  <div className="corr-scale-neg" />
                  <span>0</span>
                  <div className="corr-scale-pos" />
                  <span>+1</span>
                </div>
              </div>
            </div>
          )}
          {!busy && !result && variables.length < 2 && (
            <div className="empty-analysis">
              <div className="empty-analysis-icon">⌁</div>
              <h2>Выберите переменные</h2>
              <p>Отметьте хотя бы 2 переменные справа — матрица корреляций рассчитается автоматически.</p>
            </div>
          )}
        </div>
        <aside className="inspector">
          <div className="editor-title"><span className="eyebrow">Настройки</span><h2>Параметры</h2></div>
          <label className="field">
            <span>Метод</span>
            <select value={method} onChange={(e) => setWorkspace((p) => ({ ...p, method: e.target.value as CorrelationWorkspace["method"], result: null }))}>
              <option value="auto">Авто (Shapiro–Wilk)</option>
              <option value="pearson">Пирсон (r) — нормальное распределение</option>
              <option value="spearman">Спирмен (ρ) — любое распределение</option>
            </select>
          </label>
          <div className="variable-picker">
            <div className="picker-head">
              <span>Переменные · {variables.length} выбрано</span>
              <button onClick={() => setWorkspace((p) => ({ ...p, variables: p.variables.length === eligible.length ? [] : eligible.map((v) => v.name), result: null }))}>
                {variables.length === eligible.length ? "Снять все" : "Выбрать все"}
              </button>
            </div>
            <p className="picker-hint">Рекомендуется числовые переменные. Категориальные учитываются ограниченно.</p>
            {eligible.map((v) => (
              <div key={v.name} className={`variable-choice${variables.includes(v.name) ? " selected" : ""}`}>
                <label>
                  <input type="checkbox" checked={variables.includes(v.name)} onChange={() => toggle(v.name)} />
                  <span>{v.label}<small>{v.type} · пропуски {v.missing}</small></span>
                </label>
              </div>
            ))}
          </div>
        </aside>
        {hovered && result && (
          <ScatterTooltip dataset={dataset} schema={schema} labels={labels} hovered={hovered} result={result} method={result.method} />
        )}
        {modalCell && result && (
          <CorrelationModal
            dataset={dataset} schema={schema} labels={labels} cell={modalCell} result={result}
            inReport={workspace.reportPairs.some((p) => p.row === modalCell.row && p.col === modalCell.col)}
            onToggleReport={() => setWorkspace((p) => {
              const has = p.reportPairs.some((q) => q.row === modalCell.row && q.col === modalCell.col);
              return { ...p, reportPairs: has ? p.reportPairs.filter((q) => !(q.row === modalCell.row && q.col === modalCell.col)) : [...p.reportPairs, { row: modalCell.row, col: modalCell.col }] };
            })}
            onClose={() => setModalCell(null)}
          />
        )}
      </div>
    </section>
  );
}

function RegressionPage({ dataset, schema, workspace, setWorkspace, onOpenReport }: {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: RegressionWorkspace;
  setWorkspace: (value: RegressionWorkspace | ((current: RegressionWorkspace) => RegressionWorkspace)) => void;
  onOpenReport: () => void;
}) {
  const eligibleOutcomes = schema.filter((v) => v.role !== "id" && (v.type === "numeric" || v.type === "binary"));
  const { outcome, predictors, confidenceLevel, cutoff, result } = workspace;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const labels = Object.fromEntries(schema.map((v) => [v.name, v.label]));
  const availablePredictors = schema.filter((v) => v.name !== outcome && v.role !== "id" && v.type !== "text");
  const diagnosticMetrics = useMemo(() => {
    const predictions = result?.diagnostics?.predictions;
    if (!predictions?.length) return null;
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (const prediction of predictions) {
      const positive = prediction.probability >= cutoff;
      if (prediction.actual === 1 && positive) tp += 1;
      else if (prediction.actual === 0 && !positive) tn += 1;
      else if (prediction.actual === 0 && positive) fp += 1;
      else fn += 1;
    }
    const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
    return {
      tp, tn, fp, fn,
      sensitivity: ratio(tp, tp + fn),
      specificity: ratio(tn, tn + fp),
      efficiency: ratio(tp + tn, predictions.length),
      ppv: ratio(tp, tp + fp),
      npv: ratio(tn, tn + fn),
    };
  }, [result, cutoff]);
  const rocPath = result?.diagnostics?.roc_curve.map((point, index) =>
    `${index ? "L" : "M"} ${40 + point.fpr * 300} ${190 - point.tpr * 160}`
  ).join(" ") ?? "";

  const changeOutcome = (name: string) => {
    setWorkspace((current) => ({ ...current, outcome: name, predictors: current.predictors.filter((item) => item !== name) }));
    setError("");
  };
  const togglePredictor = (name: string) => {
    setWorkspace((current) => ({ ...current, predictors: current.predictors.includes(name) ? current.predictors.filter((item) => item !== name) : [...current.predictors, name] }));
    setError("");
  };
  useEffect(() => {
    if (!outcome || !predictors.length) {
      setWorkspace((current) => ({ ...current, result: null }));
      setError("");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      api.regression(
        dataset.rows,
        outcome,
        predictors,
        Object.fromEntries(schema.map((v) => [v.name, v])),
        confidenceLevel,
        controller.signal,
      ).then((analysis) => setWorkspace((current) => ({ ...current, result: analysis }))).catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setWorkspace((current) => ({ ...current, result: null }));
        const message = e instanceof Error ? e.message : "Не удалось рассчитать модель";
        setError(message === "Not Found" ? "Сервер не обновлён. Перезапустите run_server.py." : message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dataset.rows, outcome, predictors, confidenceLevel, schema]);
  const number = (value: number, digits = 3) => {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 1_000_000 || (value !== 0 && Math.abs(value) < 10 ** (-digits))) return value.toExponential(2).replace(".", ",");
    return value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const termLabel = (term: string) => {
    if (term === "Константа") return term;
    const [name, detail] = term.split(": ", 2);
    return detail ? `${labels[name] || name}: ${detail}` : labels[name] || name;
  };

  return (
    <section className="page regression-page">
      <div className="page-heading">
        <div><span className="eyebrow">04 · Моделирование</span><h1>Регрессия</h1><p>Оцените независимую связь факторов с бинарным или числовым исходом.</p></div>
        <button className="button secondary" disabled={!result} onClick={onOpenReport}>Предпросмотр отчёта →</button>
      </div>
      <div className="regression-layout">
        <aside className="panel regression-controls">
          <div className="panel-head"><div><h2>Спецификация модели</h2><p>Тип модели определяется по исходу</p></div></div>
          <div className="regression-control-body">
            <label className="field"><span>Исход</span><select value={outcome} onChange={(e) => changeOutcome(e.target.value)}>
              {eligibleOutcomes.map((v) => <option key={v.name} value={v.name}>{v.label} · {v.type === "binary" ? "бинарный" : "числовой"}</option>)}
            </select></label>
            <div className="regression-predictors">
              <div className="picker-head"><span>Предикторы · {predictors.length}</span><button onClick={() => setWorkspace((current) => ({ ...current, predictors: predictors.length === availablePredictors.length ? [] : availablePredictors.map((v) => v.name) }))}>{predictors.length === availablePredictors.length ? "Снять все" : "Выбрать все"}</button></div>
              {availablePredictors.map((v) => (
                <label className={`regression-predictor ${predictors.includes(v.name) ? "selected" : ""}`} key={v.name}>
                  <input type="checkbox" checked={predictors.includes(v.name)} onChange={() => togglePredictor(v.name)} />
                  <span>{v.label}<small>{v.type} · пропуски {v.missing}</small></span>
                </label>
              ))}
            </div>
            <label className="field regression-confidence"><span>Доверительный интервал</span><select value={confidenceLevel} onChange={(e) => setWorkspace((current) => ({ ...current, confidenceLevel: Number(e.target.value) }))}><option value={0.90}>90%</option><option value={0.95}>95%</option><option value={0.99}>99%</option></select></label>
            <div className={`regression-auto-status ${loading ? "is-loading" : ""} ${error ? "has-error" : ""}`}><span>{loading ? "⟳" : error ? "!" : predictors.length ? "✓" : "○"}</span>{loading ? "Модель пересчитывается…" : error ? "Расчёт не выполнен" : predictors.length ? "Результат актуален" : "Добавьте предиктор"}</div>
            <small className="regression-note">Категориальные факторы кодируются индикаторами. Наблюдения с пропусками исключаются целиком.</small>
          </div>
        </aside>

        <div className="regression-results">
          {error && <div className="regression-error">{error}</div>}
          {!result && !error && <div className="regression-empty"><span>∑</span><h2>{loading ? "Считаю модель…" : "Задайте модель"}</h2><p>{loading ? "Результат появится автоматически." : "Выберите исход и хотя бы один предиктор — расчёт запустится автоматически."}</p></div>}
          {result && (
            <>
              {(result.warnings ?? []).map((warning) => <div className="regression-warning" key={warning}><strong>Осторожно: нестабильная выборка</strong><span>{warning}</span></div>)}
              <div className="regression-summary">
                <article><span>Модель</span><strong>{result.model_type === "logistic" ? "Логистическая" : "Линейная"}</strong><small>{result.fit_method === "firth" ? "коррекция Фирта" : result.event_level ? `событие: ${result.event_level}` : `исход: ${labels[result.outcome] || result.outcome}`}</small></article>
                <article><span>Наблюдения</span><strong>{result.n}</strong><small>исключено: {result.excluded}</small></article>
                {result.model_type === "linear" ? <>
                  <article><span>R²</span><strong>{number(result.metrics.r_squared)}</strong><small>скорр. {number(result.metrics.adjusted_r_squared)}</small></article>
                  <article><span>RMSE</span><strong>{number(result.metrics.rmse)}</strong><small>ошибка модели</small></article>
                </> : <>
                  <article><span>Псевдо-R²</span><strong>{number(result.metrics.pseudo_r_squared)}</strong><small>McFadden</small></article>
                  <article><span>Точность</span><strong>{number(result.metrics.accuracy * 100, 1)}%</strong><small>AIC {number(result.metrics.aic, 1)}</small></article>
                </>}
              </div>
              {result.diagnostics && diagnosticMetrics && (
                <section className="regression-diagnostics">
                  <div className="panel diagnostic-panel roc-panel">
                    <div className="panel-head"><div><h2>ROC-кривая</h2><p>Дискриминационная способность модели</p></div><strong className="auc-value">AUC {number(result.diagnostics.auc)}</strong></div>
                    <div className="roc-chart-wrap">
                      <svg className="roc-chart" viewBox="0 0 370 225" role="img" aria-label={`ROC-кривая, AUC ${number(result.diagnostics.auc)}`}>
                        <line className="roc-axis" x1="40" y1="190" x2="340" y2="190" />
                        <line className="roc-axis" x1="40" y1="190" x2="40" y2="30" />
                        <line className="roc-reference" x1="40" y1="190" x2="340" y2="30" />
                        <path className="roc-line" d={rocPath} />
                        <circle className="roc-cutoff-point" cx={40 + (1 - diagnosticMetrics.specificity) * 300} cy={190 - diagnosticMetrics.sensitivity * 160} r="5" />
                        {[0, 0.5, 1].map((tick) => <g key={`x-${tick}`}><line className="roc-tick" x1={40 + tick * 300} y1="190" x2={40 + tick * 300} y2="195" /><text x={40 + tick * 300} y="208" textAnchor="middle">{tick.toLocaleString("ru-RU")}</text></g>)}
                        {[0, 0.5, 1].map((tick) => <g key={`y-${tick}`}><line className="roc-tick" x1="35" y1={190 - tick * 160} x2="40" y2={190 - tick * 160} /><text x="30" y={194 - tick * 160} textAnchor="end">{tick.toLocaleString("ru-RU")}</text></g>)}
                        <text className="roc-axis-label" x="190" y="222" textAnchor="middle">1 − специфичность</text>
                        <text className="roc-axis-label" x="12" y="110" textAnchor="middle" transform="rotate(-90 12 110)">Чувствительность</text>
                      </svg>
                    </div>
                  </div>
                  <div className="panel diagnostic-panel cutoff-panel">
                    <div className="panel-head"><div><h2>Порог классификации</h2><p>Вероятность положительного прогноза</p></div><strong className="cutoff-value">{number(cutoff, 2)}</strong></div>
                    <div className="cutoff-body">
                      <input className="cutoff-slider" type="range" min="0.01" max="0.99" step="0.01" value={cutoff} onChange={(e) => setWorkspace((current) => ({ ...current, cutoff: Number(e.target.value) }))} aria-label="Probability cut-off" />
                      <div className="cutoff-scale"><span>0,01</span><span>Probability cut-off</span><span>0,99</span></div>
                      <div className="diagnostic-metrics">
                        <article><span>Чувствительность</span><strong>{number(diagnosticMetrics.sensitivity * 100, 1)}%</strong></article>
                        <article><span>Специфичность</span><strong>{number(diagnosticMetrics.specificity * 100, 1)}%</strong></article>
                        <article><span>Диагн. эффективность</span><strong>{number(diagnosticMetrics.efficiency * 100, 1)}%</strong></article>
                        <article><span>PPV / NPV</span><strong>{number(diagnosticMetrics.ppv * 100, 1)}% / {number(diagnosticMetrics.npv * 100, 1)}%</strong></article>
                      </div>
                    </div>
                  </div>
                  <div className="panel diagnostic-panel confusion-panel">
                    <div className="panel-head"><div><h2>Матрица ошибок</h2><p>При cut-off {number(cutoff, 2)}</p></div></div>
                    <div className="confusion-matrix" aria-label="Матрица ошибок">
                      <div className="cm-corner">Факт ↓ / Прогноз →</div><div className="cm-head">Положительный</div><div className="cm-head">Отрицательный</div>
                      <div className="cm-head cm-row">Положительный</div><div className="cm-cell cm-correct"><strong>{diagnosticMetrics.tp}</strong><small>TP</small></div><div className="cm-cell cm-error"><strong>{diagnosticMetrics.fn}</strong><small>FN</small></div>
                      <div className="cm-head cm-row">Отрицательный</div><div className="cm-cell cm-error"><strong>{diagnosticMetrics.fp}</strong><small>FP</small></div><div className="cm-cell cm-correct"><strong>{diagnosticMetrics.tn}</strong><small>TN</small></div>
                    </div>
                  </div>
                </section>
              )}
              <div className="panel regression-table-panel">
                <div className="panel-head"><div><h2>Коэффициенты модели</h2><p>{result.model_type === "logistic" ? "OR — отношение шансов" : "β — изменение исхода при увеличении предиктора на единицу"}</p></div></div>
                <div className="table-scroll"><table className="regression-table"><thead><tr><th>Параметр</th><th>{result.model_type === "logistic" ? "β (log-odds)" : "β"}</th><th>SE</th><th>{result.model_type === "logistic" ? "OR" : "Эффект"}</th><th>{Math.round(result.confidence_level * 100)}% ДИ</th><th>p-value</th></tr></thead><tbody>
                  {result.coefficients.map((row) => <tr key={row.term}><td>{termLabel(row.term)}</td><td>{number(row.estimate)}</td><td>{number(row.standard_error)}</td><td>{number(row.effect)}</td><td>{number(row.effect_ci_lower)} — {number(row.effect_ci_upper)}</td><td className={row.p_value < 0.05 ? "significant" : ""}>{row.p_display}</td></tr>)}
                </tbody></table></div>
                {(result.references.length > 0 || result.excluded > 0) && <div className="panel-footer"><span>{result.references.length ? `Референсные уровни: ${result.references.join("; ")}. ` : ""}{result.excluded ? `Исключено из-за пропусков: ${result.excluded}.` : ""}</span></div>}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ScatterPreviewImage({ pair, dataset, schema, result }: {
  pair: { row: string; col: string };
  dataset: Dataset;
  schema: VariableSchema[];
  result: CorrelationAnalysis;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objUrl: string | null = null;
    const xSch = schema.find((s) => s.name === pair.col);
    const ySch = schema.find((s) => s.name === pair.row);
    const xValues = dataset.rows.map((r) => { const v = r[pair.col]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; });
    const yValues = dataset.rows.map((r) => { const v = r[pair.row]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; });
    const cell = result.matrix[pair.row]?.[pair.col];
    api.scatterUrl(xValues, yValues, xSch?.label ?? pair.col, ySch?.label ?? pair.row, cell?.r ?? null, cell?.stars ?? "", result.method)
      .then((u) => { objUrl = u; setUrl(u); })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.row, pair.col]);

  if (loading) return <div className="scatter-preview-loading"><span className="spinner" /></div>;
  if (!url) return null;
  return <img src={url} className="scatter-preview-img" alt={`${pair.col} vs ${pair.row}`} />;
}

function ReportPreviewPage({ slides, schema, dataset, regression, correlation, setCorrelation, onExport }: {
  slides: TableSlide[];
  schema: VariableSchema[];
  dataset: Dataset | null;
  regression: RegressionWorkspace;
  correlation: CorrelationWorkspace;
  setCorrelation: (w: CorrelationWorkspace | ((p: CorrelationWorkspace) => CorrelationWorkspace)) => void;
  onExport: () => void;
}) {
  const labels = Object.fromEntries(schema.map((v) => [v.name, v.label]));
  const tables = slides.filter((slide) => slide.analysis);
  const model = regression.result;
  const number = (value: number, digits = 3) => {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 1_000_000 || (value !== 0 && Math.abs(value) < 10 ** (-digits))) return value.toExponential(2).replace(".", ",");
    return value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const diagnostics = useMemo(() => {
    const predictions = model?.diagnostics?.predictions;
    if (!predictions?.length) return null;
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (const item of predictions) {
      const positive = item.probability >= regression.cutoff;
      if (item.actual === 1 && positive) tp++; else if (item.actual === 0 && !positive) tn++; else if (positive) fp++; else fn++;
    }
    const ratio = (a: number, b: number) => b ? a / b : 0;
    return { tp, tn, fp, fn, sensitivity: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp), efficiency: ratio(tp + tn, predictions.length) };
  }, [model, regression.cutoff]);
  const rocPath = model?.diagnostics?.roc_curve.map((point, index) => `${index ? "L" : "M"} ${35 + point.fpr * 250} ${165 - point.tpr * 135}`).join(" ") ?? "";

  return (
    <section className="page report-preview-page">
      <div className="page-heading">
        <div><span className="eyebrow">05 · Итоговый документ</span><h1>Предпросмотр отчёта</h1><p>Все рассчитанные разделы проекта в порядке экспорта.</p></div>
        <button className="button primary" disabled={!tables.length && !model && !correlation.result} onClick={onExport}>Экспортировать DOCX</button>
      </div>
      {!tables.length && !model && <div className="regression-empty"><span>▤</span><h2>Отчёт пока пуст</h2><p>Рассчитайте описательную таблицу или регрессионную модель — результат появится здесь автоматически.</p></div>}
      <div className="report-pages">
        {tables.map((slide, tableIndex) => {
          const analysis = slide.analysis!;
          return <article className="report-paper" key={slide.id}>
            <div className="report-section-label">Раздел {tableIndex + 1} · Описательная статистика</div>
            <h2>{slide.settings.title}</h2>
            {slide.settings.description && <p className="report-description">{slide.settings.description}</p>}
            <div className="table-scroll"><table className="report-preview-table"><thead><tr><th>Показатель</th>{slide.settings.showOverall && <th>Все (n={analysis.n})</th>}{analysis.groups.map((group) => <th key={group.name}>{group.name}<small>n={group.n}</small></th>)}<th>p-value</th></tr></thead><tbody>
              {analysis.rows.map((row) => <Fragment key={row.variable}><tr><td>{labels[row.variable] || row.variable}<small>{row.presentation}</small></td>{slide.settings.showOverall && <td>{row.overall}</td>}{analysis.groups.map((group) => <td key={group.name}>{row.groups[group.name]}</td>)}<td>{row.p_display}</td></tr>{row.levels.map((level) => <tr className="category-level" key={`${row.variable}-${level.level}`}><td>↳ {level.level}</td>{slide.settings.showOverall && <td>{level.overall}</td>}{analysis.groups.map((group) => <td key={group.name}>{level.groups[group.name]}</td>)}<td /></tr>)}</Fragment>)}
            </tbody></table></div>
            <p className="report-method-note">{analysis.note}</p>
          </article>;
        })}
        {model && <article className="report-paper">
          <div className="report-section-label">Раздел {tables.length + 1} · Регрессионный анализ</div>
          <h2>{model.model_type === "logistic" ? "Бинарная логистическая регрессия" : "Линейная регрессия"}</h2>
          <p className="report-description">Исход: {labels[model.outcome] || model.outcome}. Включено наблюдений: {model.n}; исключено: {model.excluded}.</p>
          {(model.warnings ?? []).map((warning) => <div className="report-warning" key={warning}><strong>Метод: логистическая регрессия Фирта.</strong> {warning}</div>)}
          <div className="table-scroll"><table className="report-preview-table"><thead><tr><th>Параметр</th><th>β</th><th>SE</th><th>{model.model_type === "logistic" ? "OR" : "Эффект"}</th><th>{Math.round(model.confidence_level * 100)}% ДИ</th><th>p-value</th></tr></thead><tbody>
            {model.coefficients.map((row) => <tr key={row.term}><td>{row.term}</td><td>{number(row.estimate)}</td><td>{number(row.standard_error)}</td><td>{number(row.effect)}</td><td>{number(row.effect_ci_lower)}–{number(row.effect_ci_upper)}</td><td>{row.p_display}</td></tr>)}
          </tbody></table></div>
          {model.diagnostics && diagnostics && <div className="report-diagnostic-preview">
            <div><h3>ROC-кривая</h3><svg viewBox="0 0 315 190" role="img" aria-label={`ROC AUC ${number(model.diagnostics.auc)}`}><line className="roc-axis" x1="35" y1="165" x2="285" y2="165"/><line className="roc-axis" x1="35" y1="165" x2="35" y2="30"/><line className="roc-reference" x1="35" y1="165" x2="285" y2="30"/><path className="roc-line" d={rocPath}/></svg><strong>AUC {number(model.diagnostics.auc)}</strong></div>
            <div><h3>Диагностика при cut-off {number(regression.cutoff, 2)}</h3><div className="report-metrics"><span>Чувствительность <strong>{number(diagnostics.sensitivity * 100, 1)}%</strong></span><span>Специфичность <strong>{number(diagnostics.specificity * 100, 1)}%</strong></span><span>Эффективность <strong>{number(diagnostics.efficiency * 100, 1)}%</strong></span></div><div className="report-confusion"><span>TP <strong>{diagnostics.tp}</strong></span><span>FN <strong>{diagnostics.fn}</strong></span><span>FP <strong>{diagnostics.fp}</strong></span><span>TN <strong>{diagnostics.tn}</strong></span></div></div>
          </div>}
        </article>}
        {correlation.result && (correlation.includeMatrix || correlation.reportPairs.length > 0) && (() => {
          const cr = correlation.result!;
          const corrLabels = cr.labels ?? {};
          const corrMatrix = cr.matrix ?? {};
          const vars = cr.variables ?? [];
          const sectionNum = tables.length + (model ? 1 : 0) + 1;
          const symbol = cr.method === "pearson" ? "r" : "ρ";
          return (
            <article className="report-paper">
              <div className="report-section-label">Раздел {sectionNum} · Корреляционный анализ</div>
              <h2>Корреляционный анализ</h2>
              <p className="report-description">
                Метод: {cr.method === "pearson" ? "Пирсон (r)" : "Спирмен (ρ)"}. N = {cr.n}.
              </p>
              {correlation.includeMatrix && vars.length > 0 && (
                <div className="table-scroll">
                  <table className="report-preview-table corr-report-table">
                    <thead>
                      <tr>
                        <th />
                        {vars.map((v) => <th key={v}>{corrLabels[v] ?? v}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {vars.map((row) => (
                        <tr key={row}>
                          <td><strong>{corrLabels[row] ?? row}</strong></td>
                          {vars.map((col) => {
                            if (row === col) return <td key={col} className="corr-report-diag">—</td>;
                            const cell = corrMatrix[row]?.[col];
                            return (
                              <td key={col} style={{ textAlign: "center" }}>
                                {cell?.r != null ? `${cell.r.toFixed(3)}${cell.stars}` : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {correlation.includeMatrix && <p className="report-method-note">* p&lt;0,05  ** p&lt;0,01  *** p&lt;0,001 ({symbol} — коэффициент корреляции)</p>}
              {correlation.reportPairs.length > 0 && (
                <div className="corr-report-scatter-grid">
                  {correlation.reportPairs.map((p) => {
                    const cell = corrMatrix[p.row]?.[p.col];
                    const xL = schema.find((s) => s.name === p.col)?.label ?? corrLabels[p.col] ?? p.col;
                    const yL = schema.find((s) => s.name === p.row)?.label ?? corrLabels[p.row] ?? p.row;
                    return (
                      <div key={`${p.row}-${p.col}`} className="corr-report-scatter-card">
                        <div className="corr-report-scatter-header">
                          <span className="corr-report-scatter-title">{xL} vs {yL}</span>
                          {cell?.r != null && <span className="corr-chip-r">{symbol} = {cell.r.toFixed(3)}{cell.stars}</span>}
                          <button className="corr-report-scatter-remove" onClick={() => setCorrelation((prev) => ({ ...prev, reportPairs: prev.reportPairs.filter((q) => !(q.row === p.row && q.col === p.col)) }))}>✕</button>
                        </div>
                        {dataset && cr && <ScatterPreviewImage pair={p} dataset={dataset} schema={schema} result={cr} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })()}
      </div>
    </section>
  );
}

export default App;
