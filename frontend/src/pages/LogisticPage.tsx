import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../api";
import type { Dataset, VariableSchema, LogisticTableWorkspace, LogisticTableRow, LogisticUniResult, LogisticMultiResult } from "../types";
import { formatOR } from "../utils";

function LogisticForestPlot({ result, labels }: { result: LogisticMultiResult; labels: Record<string, string> }) {
  const entries = Object.entries(result.coefficients);
  if (!entries.length) return null;

  const allVals = entries.flatMap(([, c]) => [c.or, c.ci_lower, c.ci_upper]).filter(isFinite);
  const rawMin = Math.min(...allVals, 0.5);
  const rawMax = Math.max(...allVals, 2);
  const pad = (rawMax - rawMin) * 0.10;
  const xMin = Math.max(0.01, rawMin - pad);
  const xMax = rawMax + pad;

  const ROW_H = 40;
  const TOP = 26, BOTTOM = 30;
  const LABEL_W = 148, PLOT_W = 190, GAP = 12;
  const COL_OR = 90, COL_P = 52;
  const W = LABEL_W + PLOT_W + GAP + COL_OR + GAP + COL_P;
  const H = TOP + entries.length * ROW_H + BOTTOM;
  const PX = LABEL_W;

  const toX = (v: number) => PX + (Math.log(v) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin)) * PLOT_W;
  const nullX = toX(1);

  const RX_OR = LABEL_W + PLOT_W + GAP;
  const RX_P  = RX_OR + COL_OR + GAP;
  const AXIS_Y = TOP + entries.length * ROW_H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="forest-plot-svg">
      {/* column headers */}
      <text x={RX_OR + COL_OR / 2} y={TOP - 8} textAnchor="middle" fontSize="9" fontWeight="600" fill="#6b7280">ОШ (95% ДИ)</text>
      <text x={RX_P  + COL_P / 2}  y={TOP - 8} textAnchor="middle" fontSize="9" fontWeight="600" fill="#6b7280">p-value</text>

      {/* null line behind rows */}
      <line x1={nullX} y1={TOP} x2={nullX} y2={AXIS_Y} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 3" />

      {entries.map(([pred, c], i) => {
        const y = TOP + i * ROW_H + ROW_H / 2;
        const x0 = toX(Math.max(c.ci_lower, xMin));
        const x1 = toX(Math.min(c.ci_upper, xMax));
        const xOR = toX(Math.max(xMin, Math.min(c.or, xMax)));
        const label = labels[pred] || pred;
        const displayLabel = label.length > 20 ? label.slice(0, 19) + "…" : label;
        const orText = `${c.or.toFixed(2)} (${c.ci_lower.toFixed(2)}–${c.ci_upper.toFixed(2)})`;
        const INK = "#1f2937";

        return (
          <g key={pred}>
            {i % 2 === 1 && <rect x={0} y={y - ROW_H / 2} width={W} height={ROW_H} fill="#f8fafc" />}
            <text x={LABEL_W - 8} y={y + 4} textAnchor="end" fontSize="11" fill={INK}>{displayLabel}</text>
            {/* CI whisker */}
            <line x1={x0} y1={y} x2={x1} y2={y} stroke={INK} strokeWidth="1.5" />
            <line x1={x0} y1={y - 4} x2={x0} y2={y + 4} stroke={INK} strokeWidth="1.5" />
            <line x1={x1} y1={y - 4} x2={x1} y2={y + 4} stroke={INK} strokeWidth="1.5" />
            {/* OR tick: thin vertical bar */}
            <line x1={xOR} y1={y - 7} x2={xOR} y2={y + 7} stroke={INK} strokeWidth="2.5" />
            {/* OR (CI) text */}
            <text x={RX_OR + COL_OR / 2} y={y + 4} textAnchor="middle" fontSize="10" fill={INK}>{orText}</text>
            {/* p-value */}
            <text x={RX_P + COL_P / 2} y={y + 4} textAnchor="middle" fontSize="10" fill={INK}>{c.p_display}</text>
          </g>
        );
      })}

      {/* X axis */}
      <line x1={PX} y1={AXIS_Y} x2={PX + PLOT_W} y2={AXIS_Y} stroke="#94a3b8" strokeWidth="1" />
      {[xMin, 1, xMax].map((v) => {
        const tx = toX(v);
        const lbl = v === 1 ? "1" : v < 1 ? v.toFixed(2) : v.toFixed(1);
        return (
          <g key={v}>
            <line x1={tx} y1={AXIS_Y} x2={tx} y2={AXIS_Y + 4} stroke="#94a3b8" strokeWidth="1" />
            <text x={tx} y={AXIS_Y + 13} textAnchor="middle" fontSize="9" fill="#6b7280">{lbl}</text>
          </g>
        );
      })}
      <text x={nullX} y={AXIS_Y + 24} textAnchor="middle" fontSize="8" fill="#9ca3af">ОШ</text>
    </svg>
  );
}

function generateInsight(rows: LogisticTableRow[], multiResult: LogisticMultiResult | null, labels: Record<string, string>): string {
  const done = rows.filter((r) => r.univariate);
  if (!done.length) return "Добавьте предикторы, чтобы начать анализ.";

  const strongest = done.sort((a, b) => (a.univariate!.p_value) - (b.univariate!.p_value))[0];
  const sName = labels[strongest.predictor] || strongest.predictor;
  let text = `Однофакторный анализ показывает, что наиболее значимым предиктором является ${sName} (ОШ ${strongest.univariate!.or.toFixed(2)}, p ${strongest.univariate!.p_display}).`;

  if (multiResult) {
    const coeffs = Object.entries(multiResult.coefficients);
    const sigMulti = coeffs.filter(([, c]) => c.p_value < 0.05);
    const nsSig = coeffs.filter(([, c]) => c.p_value >= 0.05);
    if (sigMulti.length) {
      const names = sigMulti.map(([p]) => labels[p] || p).join(", ");
      text += ` В многофакторной модели независимое значение сохраняют: ${names}.`;
    }
    if (nsSig.length) {
      const names = nsSig.map(([p]) => labels[p] || p).join(", ");
      text += ` Факторы без независимого значения (p > 0,05): ${names}.`;
    }
    text += ` Nagelkerke R² = ${multiResult.nagelkerke_r2.toFixed(3)}.`;
  }
  return text;
}

export interface LogisticTablePageProps {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: LogisticTableWorkspace;
  setWorkspace: (w: LogisticTableWorkspace | ((prev: LogisticTableWorkspace) => LogisticTableWorkspace)) => void;
}

export function LogisticTablePage({ dataset, schema, workspace, setWorkspace }: LogisticTablePageProps) {
  const [search, setSearch] = useState("");
  const [bgUnivariate, setBgUnivariate] = useState<Record<string, (LogisticUniResult & { error?: string })>>({});
  const [bgLoading, setBgLoading] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropPos, setDropPos] = useState<{ idx: number; before: boolean } | null>(null);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const multiAbortRef = useRef<AbortController | null>(null);
  const bgAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (outcomeRef.current && !outcomeRef.current.contains(e.target as Node)) setOutcomeOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const labels = useMemo(() => Object.fromEntries(schema.map((v) => [v.name, v.label])), [schema]);
  const binaryOutcomes = useMemo(() => schema.filter((v) => v.type === "binary" || (v.type === "categorical" && v.unique === 2)), [schema]);
  const allPredictors = useMemo(() =>
    schema.filter((v) => v.role !== "id" && v.type !== "text" && v.name !== workspace.outcome),
  [schema, workspace.outcome]);

  // ── background univariate for ALL predictors when outcome changes ──────────
  useEffect(() => {
    if (!workspace.outcome) { setBgUnivariate({}); setBgLoading(false); return; }
    bgAbortRef.current?.abort();
    const ctrl = new AbortController();
    bgAbortRef.current = ctrl;
    setBgUnivariate({});
    setBgLoading(true);
    const names = allPredictors.map((v) => v.name);
    if (!names.length) { setBgLoading(false); return; }
    api.logisticUnivariate(dataset.rows, workspace.outcome, names, {}, 0.95, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setBgUnivariate(res.univariate as Record<string, LogisticUniResult & { error?: string }>);
        setBgLoading(false);
        // back-fill any rows added before bg finished
        setWorkspace((prev) => ({
          ...prev,
          rows: prev.rows.map((r) => {
            if (!r.univariateLoading) return r;
            const d = res.univariate[r.predictor];
            if (!d) return r;
            return { ...r, univariateLoading: false, univariate: d.error ? null : (d as LogisticUniResult), univariateError: d.error ?? null };
          }),
        }));
      })
      .catch(() => { if (!ctrl.signal.aborted) setBgLoading(false); });
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.outcome, dataset]);

  // ── multivariate auto-runner ───────────────────────────────────────────────
  const multivariatePredictors = workspace.rows.map((r) => r.predictor);
  useEffect(() => {
    if (!workspace.outcome || multivariatePredictors.length < 2) {
      setWorkspace((prev) => ({ ...prev, multiResult: null, multiLoading: false }));
      return;
    }
    multiAbortRef.current?.abort();
    const ctrl = new AbortController();
    multiAbortRef.current = ctrl;
    setWorkspace((prev) => ({ ...prev, multiLoading: true }));
    api.logisticMultivariate(dataset.rows, workspace.outcome, multivariatePredictors, {}, 0.95, ctrl.signal)
      .then((res) => { if (!ctrl.signal.aborted) setWorkspace((prev) => ({ ...prev, multiResult: res, multiLoading: false })); })
      .catch(() => { if (!ctrl.signal.aborted) setWorkspace((prev) => ({ ...prev, multiLoading: false })); });
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.outcome, multivariatePredictors.join(","), dataset]);

  // ── drag-to-reorder ────────────────────────────────────────────────────────
  const onDragEnd = () => {
    if (dragIdx !== null && dropPos !== null) {
      const insertAt = dropPos.before ? dropPos.idx : dropPos.idx + 1;
      const adjustedInsert = insertAt > dragIdx ? insertAt - 1 : insertAt;
      if (adjustedInsert !== dragIdx) {
        setWorkspace((prev) => {
          const rows = [...prev.rows];
          const [moved] = rows.splice(dragIdx, 1);
          rows.splice(adjustedInsert, 0, moved);
          return { ...prev, rows };
        });
      }
    }
    setDragIdx(null);
    setDropPos(null);
  };

  // ── add / remove ───────────────────────────────────────────────────────────
  const togglePredictor = (name: string) => {
    const inTable = workspace.rows.some((r) => r.predictor === name);
    if (inTable) {
      setWorkspace((prev) => ({ ...prev, rows: prev.rows.filter((r) => r.predictor !== name) }));
    } else {
      const bg = bgUnivariate[name];
      const univariate = bg && !bg.error ? bg : null;
      setWorkspace((prev) => ({
        ...prev,
        rows: [...prev.rows, { predictor: name, inMultivariate: true, univariate, univariateLoading: !univariate && !bg, univariateError: bg?.error ?? null }],
      }));
    }
  };

  const pCell = (p: number, pDisplay: string, forMulti = false) => {
    const sig = p < 0.05;
    return <span className={`lgt-p ${forMulti ? (sig ? "lgt-p--sig" : "lgt-p--ns") : (sig ? "lgt-p--sig-uni" : "")}`}>{pDisplay}</span>;
  };

  const multiCoeffs = workspace.multiResult?.coefficients ?? {};
  const insight = generateInsight(workspace.rows, workspace.multiResult, labels);
  const filteredPredictors = allPredictors.filter((v) =>
    !search || v.label.toLowerCase().includes(search.toLowerCase()) || v.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <section className="analysis-layout lgt-layout">
      <div className="analysis-main">
        <div className="lgt-header">
          <div className="lgt-header-left">
            <span className="eyebrow">03 · Регрессионный анализ</span>
            <h1 className="lgt-header-title">Логистическая регрессия</h1>
          </div>
          <span className="lgt-badge">LOGISTIC REGRESSION</span>
        </div>

        {/* Outcome selector — prominent step */}
        <div className="lgt-outcome-bar" ref={outcomeRef}>
          <div className="lgt-outcome-bar-label">
            <span className="lgt-outcome-step">1</span>
            <div>
              <div className="lgt-outcome-bar-title">Переменная исхода</div>
              <div className="lgt-outcome-bar-hint">Выберите бинарный исход для анализа</div>
            </div>
          </div>
          <div className="lgt-outcome-picker">
            <button
              className={`lgt-outcome-btn${outcomeOpen ? " lgt-outcome-btn--open" : ""}${workspace.outcome ? " lgt-outcome-btn--set" : ""}`}
              onClick={() => setOutcomeOpen((v) => !v)}
            >
              <span className="lgt-outcome-value">
                {workspace.outcome ? (labels[workspace.outcome] || workspace.outcome) : "— выберите переменную —"}
              </span>
              <svg className="lgt-outcome-chevron" viewBox="0 0 12 12" fill="none">
                <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {outcomeOpen && (
              <div className="lgt-outcome-dropdown">
                {binaryOutcomes.length === 0 && <div className="lgt-outcome-empty">Нет бинарных переменных</div>}
                {binaryOutcomes.map((v) => (
                  <button
                    key={v.name}
                    className={`lgt-outcome-option${workspace.outcome === v.name ? " lgt-outcome-option--active" : ""}`}
                    onClick={() => { setWorkspace({ outcome: v.name, rows: [], multiResult: null, multiLoading: false }); setOutcomeOpen(false); }}
                  >
                    <span className="lgt-outcome-option-label">{v.label}</span>
                    <span className="lgt-outcome-option-meta">{v.unique} уровня · n={v.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!workspace.outcome
          ? null
          : (
            <div className="lgt-body">
              {/* ── Left: predictor card picker ── */}
              <div className="lgt-picker-wrapper">
              <div className="lgt-picker-panel">
                <div className="lgt-picker-panel-title">
                  Предикторы
                  {bgLoading && <span className="lgt-bg-spin" title="Расчёт p-value…" />}
                </div>
                <input className="lgt-picker-search" placeholder="Поиск…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="lgt-card-grid">
                  {filteredPredictors.map((v) => {
                    const bg = bgUnivariate[v.name];
                    const inTable = workspace.rows.some((r) => r.predictor === v.name);
                    const sig = bg && !bg.error ? bg.p_value < 0.05 : null;
                    return (
                      <button
                        key={v.name}
                        className={`lgt-pred-card${inTable ? " lgt-pred-card--selected" : ""}${sig === true ? " lgt-pred-card--sig" : sig === false ? " lgt-pred-card--ns" : ""}`}
                        onClick={() => togglePredictor(v.name)}
                        title={inTable ? "Убрать из анализа" : "Добавить в анализ"}
                      >
                        <div className="lgt-pred-card-top">
                          <span className="lgt-pred-card-name">{v.label}</span>
                          {inTable && <span className="lgt-pred-card-check">✓</span>}
                        </div>
                        <div className="lgt-pred-card-bottom">
                          <span className={`lgt-type-chip lgt-type-${v.type}`}>{v.type.toUpperCase()}</span>
                          {bgLoading && !bg
                            ? <span className="lgt-pred-p-loading">…</span>
                            : bg && !bg.error
                              ? <span className={`lgt-pred-p-badge${sig ? " sig" : " ns"}`}>{bg.p_value < 0.001 ? "p < 0,001" : `p = ${bg.p_display}`}</span>
                              : bg?.error ? <span className="lgt-pred-p-badge ns">ошибка</span> : null}
                        </div>
                      </button>
                    );
                  })}
                  {filteredPredictors.length === 0 && <div className="lgt-picker-empty">Ничего не найдено</div>}
                </div>
              </div>
              </div>

              {/* ── Right: regression table + panels ── */}
              <div className="lgt-right">
                <div className="lgt-table-wrap">
                  <table className="lgt-table">
                    <thead>
                      <tr>
                        <th rowSpan={2} className="lgt-th-var">Показатель</th>
                        <th colSpan={2} className="lgt-th-group">Однофакторный анализ</th>
                        <th colSpan={2} className="lgt-th-group lgt-th-multi">Многофакторный анализ</th>
                        <th rowSpan={2} className="lgt-th-act"></th>
                      </tr>
                      <tr>
                        <th className="lgt-th-sub">ОШ (95% ДИ)</th>
                        <th className="lgt-th-sub lgt-th-p">p-value</th>
                        <th className="lgt-th-sub lgt-th-multi">ОШ (95% ДИ)</th>
                        <th className="lgt-th-sub lgt-th-p lgt-th-multi">p-value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspace.rows.length === 0 && (
                        <tr><td colSpan={6} className="lgt-empty-row">Выберите предикторы слева →</td></tr>
                      )}
                      {workspace.rows.map((row, i) => {
                        const mc = multiCoeffs[row.predictor];
                        const isDragging = dragIdx === i;
                        const showBefore = dropPos?.idx === i && dropPos.before && !isDragging;
                        const showAfter  = dropPos?.idx === i && !dropPos.before && !isDragging;
                        return (
                          <tr
                            key={row.predictor}
                            className={`lgt-row${isDragging ? " lgt-row--dragging" : ""}${showBefore ? " lgt-row--drop-before" : ""}${showAfter ? " lgt-row--drop-after" : ""}`}
                            draggable
                            onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setDropPos({ idx: i, before: e.clientY < rect.top + rect.height / 2 });
                            }}
                            onDragLeave={() => setDropPos(null)}
                            onDragEnd={onDragEnd}
                          >
                            <td className="lgt-td-var">
                              <span className="lgt-drag-handle">⠿</span>
                              {labels[row.predictor] || row.predictor}
                            </td>
                            <td className="lgt-td-or">
                              {row.univariateLoading ? <span className="lgt-loading">…</span>
                                : row.univariateError ? <span className="lgt-error">!</span>
                                : row.univariate ? formatOR(row.univariate.or, row.univariate.ci_lower, row.univariate.ci_upper) : "—"}
                            </td>
                            <td className="lgt-td-p">{row.univariate ? pCell(row.univariate.p_value, row.univariate.p_display) : "—"}</td>
                            <td className="lgt-td-or lgt-td-multi">
                              {workspace.multiLoading ? <span className="lgt-loading">…</span>
                                : mc ? formatOR(mc.or, mc.ci_lower, mc.ci_upper) : "—"}
                            </td>
                            <td className="lgt-td-p lgt-td-multi">
                              {mc ? pCell(mc.p_value, mc.p_display, true) : <span className="lgt-muted">—</span>}
                            </td>
                            <td className="lgt-td-act">
                              <button className="lgt-del" onClick={() => togglePredictor(row.predictor)} title="Убрать">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {workspace.multiResult && (
                    <div className="lgt-footer">
                      <span>N = {workspace.multiResult.n.toLocaleString("ru-RU")}</span>
                      <span>χ² = {workspace.multiResult.chi2.toFixed(1)} (p {workspace.multiResult.chi2_p_display})</span>
                      <span>Nagelkerke R² = {workspace.multiResult.nagelkerke_r2.toFixed(3)}</span>
                      {workspace.multiResult.warnings.length > 0 && <span className="lgt-warn">⚠ Firth</span>}
                      <span className="lgt-legend"><span className="lgt-dot lgt-dot-ns" /> p &gt; 0,05</span>
                    </div>
                  )}
                </div>

                <div className="lgt-panels">
                  <div className="lgt-panel lgt-panel-forest">
                    <div className="lgt-panel-title">Forest Plot</div>
                    {workspace.multiResult
                      ? <LogisticForestPlot result={workspace.multiResult} labels={labels} />
                      : <div className="lgt-forest-empty">Добавьте ≥ 2 предиктора в многофакторную модель</div>}
                  </div>
                  <div className="lgt-panel lgt-panel-insight">
                    <div className="lgt-panel-title">Аналитическое резюме</div>
                    <p className="lgt-insight-text">{insight}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>
    </section>
  );
}

export default LogisticTablePage;
