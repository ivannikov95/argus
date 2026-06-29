import { Fragment, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { ExportOptions, ProjectMeta } from "./api";
import type { AnalysisRow, Dataset, TableOneAnalysis, VariableSchema } from "./types";

// One independent table page in the multi-table report
interface TableSlide {
  id: string;
  group: string | null;
  selected: string[];
  settings: TableEditorSettings;
  analysis: TableOneAnalysis | null;
}

type Page = "home" | "dataset" | "variables" | "table";

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
  { id: "groups", label: "Сравнение групп", mark: "⇄", enabled: false },
  { id: "correlation", label: "Корреляции", mark: "⌁", enabled: false },
  { id: "regression", label: "Регрессия", mark: "∑", enabled: false },
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

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  // Read URL once synchronously to set correct initial state — no home-page flash
  const [page, setPage] = useState<Page>(() => {
    const m = window.location.pathname.match(/\/(dataset|variables|table)$/);
    return (m?.[1] as Page) ?? "home";
  });
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [schema, setSchema] = useState<VariableSchema[]>([]);
  const [slides, setSlides] = useState<TableSlide[]>([makeSlide({ id: "s1" })]);
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
  const [restoring, setRestoring] = useState(() =>
    /^\/project\//.test(window.location.pathname)
  );
  // project ID extracted from URL for startup load
  const startupPid = useRef(
    window.location.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    const suggestedGroup =
      next.schema.find((v) => v.name.toLowerCase().includes("group") && v.unique <= 8)?.name ??
      next.schema.find((v) => ["binary", "categorical"].includes(v.type) && v.role !== "id" && v.unique <= 8)?.name ??
      null;
    setSlides([makeSlide({ id: "s1", group: suggestedGroup })]);
    setCurrentIndex(0);
  };

  const refreshProjects = () => { api.listProjects().then(setSavedProjects).catch(() => {}); };

  // On mount: restore project from URL (e.g. /project/some-id/table on refresh)
  useEffect(() => {
    refreshProjects();
    const pid = startupPid.current;
    if (pid) {
      loadProject(pid)
        .catch(() => navigate("/", { replace: true }))
        .finally(() => setRestoring(false));
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
      setNewDataset(await api.upload(file));
      setProjectName(file.name.replace(/\.[^.]+$/, ""));
      setCurrentProjectId(null);
      setSaveStatus("dirty");
      setPage("dataset");
      setNotice("Датасет загружен и проверен");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось загрузить файл");
    } finally { setBusy(""); }
  };

  const loadProject = async (projectId: string) => {
    setBusy("Загружаю проект…");
    try {
      const saved = await api.loadProject(projectId);
      const ds = await api.profileDataset(saved.rows, saved.file_name);
      const overrides = saved.variable_overrides as Record<string, VariableSchema>;
      const mergedSchema = ds.schema.map((col) => overrides[col.name] ? { ...col, ...overrides[col.name] } : col);
      setDataset(ds);
      setSchema(mergedSchema);
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
      setPage(hasAny ? "table" : "dataset");
      setNotice(`Проект «${saved.project_name}» загружен`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Не удалось загрузить проект");
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
      currentProjectId ? `/project/${currentProjectId}/${page}` : "/";
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
    // backward compat fields
    last_analysis: slides[0]?.analysis ?? null,
    table_settings: slides[0]?.settings ?? {},
  }), [dataset, schema, slides]);

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
  }, [dataset, schema, slides, projectName]);

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
    if (!computed.length) { setNotice("Нет рассчитанных таблиц для экспорта"); return; }
    setBusy("Собираю отчёт…");
    try {
      const tables: ExportOptions[] = computed.map(({ s, idx }) => buildExportOptions(s, s.selected, idx + 1));
      download(await api.exportReport(tables), "report.docx");
      setNotice(`Отчёт сформирован (${computed.length} табл.)`);
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
        <div className="brand"><span className="brand-sign">M</span><div><strong>MedStat Studio</strong><small>Research workspace · MVP</small></div></div>
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
            <span className="brand-sign" style={{width:24,height:24,borderRadius:6,fontSize:12}}>M</span>
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
            <div className="brand-sign" style={{ width: 30, height: 30, borderRadius: 7, fontSize: 14 }}>M</div>
            <strong>MedStat Studio</strong>
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
            <div className="home-hero-eyebrow">Biomedical Statistics Workspace</div>
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
  const draggedRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ name: string; edge: "before" | "after" } | null>(null);
  const variableRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const labels = Object.fromEntries(schema.map((item) => [item.name, item.label]));
  const available = schema.filter((v) => v.role !== "id" && v.type !== "text" && v.name !== group);
  const availableNames = new Set(available.map((v) => v.name));
  const pickerVariables = [
    ...selected.map((name) => available.find((v) => v.name === name)).filter((v): v is VariableSchema => Boolean(v)),
    ...available.filter((v) => !selected.includes(v.name)),
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

  const moveVariable = (name: string, direction: -1 | 1) => {
    const index = selected.indexOf(name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(next);
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

export default App;
