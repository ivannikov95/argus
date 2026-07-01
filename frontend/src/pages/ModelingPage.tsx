import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../api";
import type { Dataset, VariableSchema, ModelingWorkspace, ModelingResult, ModelingSplitMetrics, CorrelationAnalysis } from "../types";

export interface ModelingPageProps {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: ModelingWorkspace;
  setWorkspace: (v: ModelingWorkspace | ((p: ModelingWorkspace) => ModelingWorkspace)) => void;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }
function fmt2(v: number) { return v.toFixed(2); }
function pBadge(p: number | null) {
  if (p === null) return null;
  const sig = p < 0.05;
  return (
    <span className={`ml-p-badge${sig ? " ml-p-badge--sig" : " ml-p-badge--ns"}`}>
      {p < 0.001 ? "p < 0,001" : `p = ${p.toFixed(3).replace(".", ",")}`}
    </span>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({ current, onGo }: { current: number; onGo: (s: 1 | 2 | 3) => void }) {
  const steps = [
    { n: 1, label: "Отбор предикторов" },
    { n: 2, label: "Проверка мультиколлинеарности" },
    { n: 3, label: "Обучение модели" },
  ] as const;
  return (
    <div className="ml-stepbar">
      {steps.map((s, i) => (
        <div key={s.n} className="ml-stepbar-item">
          <button
            className={`ml-step${current === s.n ? " ml-step--active" : current > s.n ? " ml-step--done" : ""}`}
            onClick={() => current > s.n && onGo(s.n)}
            disabled={current <= s.n}
          >
            <span className="ml-step-num">{current > s.n ? "✓" : s.n}</span>
            <span className="ml-step-label">{s.label}</span>
          </button>
          {i < steps.length - 1 && <div className={`ml-step-connector${current > s.n ? " done" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

// ── ROC chart ────────────────────────────────────────────────────────────────
function RocChart({ splits, localCutoff, youdenCutoff }: {
  splits: { label: string; color: string; data: ModelingSplitMetrics }[];
  localCutoff: number;
  youdenCutoff?: number;
}) {
  const W = 400, H = 320, PAD = { l: 46, r: 16, t: 14, b: 38 };
  const px = (v: number) => PAD.l + v * (W - PAD.l - PAD.r);
  const py = (v: number) => H - PAD.b - v * (H - PAD.t - PAD.b);

  // Find test split for cutoff markers
  const testSplit = splits.find((s) => s.label === "Тест");
  const findPtAtCutoff = (cutoff: number) => {
    if (!testSplit) return null;
    const pts = testSplit.data.roc_curve.filter((p) => p.threshold !== undefined);
    if (!pts.length) return null;
    let best = pts[0], bestDist = Math.abs((best.threshold ?? 0) - cutoff);
    for (const p of pts) {
      const d = Math.abs((p.threshold ?? 0) - cutoff);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return { x: px(best.fpr), y: py(best.tpr) };
  };

  const currentDot = findPtAtCutoff(localCutoff);
  const youdenDot = youdenCutoff !== undefined ? findPtAtCutoff(youdenCutoff) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ml-roc-svg">
      {/* grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <line key={v} x1={PAD.l} y1={py(v)} x2={W - PAD.r} y2={py(v)} stroke="#f3f4f6" strokeWidth="1" />
      ))}
      <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="#e5e7eb" strokeWidth="1" />
      <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#e5e7eb" strokeWidth="1" />
      <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={PAD.t} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="5 4" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <text x={PAD.l - 5} y={py(v) + 4} textAnchor="end" fontSize="10" fill="#9ca3af">{v.toFixed(1)}</text>
          <text x={px(v)} y={H - PAD.b + 13} textAnchor="middle" fontSize="10" fill="#9ca3af">{v.toFixed(1)}</text>
        </g>
      ))}
      <text x={PAD.l - 26} y={H / 2} textAnchor="middle" fontSize="10" fill="#6b7280" transform={`rotate(-90 ${PAD.l - 26} ${H / 2})`}>Чувствительность</text>
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 5} textAnchor="middle" fontSize="10" fill="#6b7280">1 − Специфичность</text>
      {/* curves */}
      {splits.map(({ label, color, data }) => {
        const pts = data.roc_curve.map((p, i) => `${i ? "L" : "M"}${px(p.fpr).toFixed(1)},${py(p.tpr).toFixed(1)}`).join(" ");
        return <path key={label} d={pts} fill="none" stroke={color} strokeWidth="2" />;
      })}
      {/* Youden dot (green) */}
      {youdenDot && (
        <circle cx={youdenDot.x} cy={youdenDot.y} r={6} fill="#059669" stroke="#fff" strokeWidth="1.5" />
      )}
      {/* Current cutoff dot (orange) */}
      {currentDot && (
        <circle cx={currentDot.x} cy={currentDot.y} r={5} fill="#f59e0b" stroke="#fff" strokeWidth="1.5" />
      )}
      {/* legend */}
      {splits.map(({ label, color, data }, i) => (
        <g key={label} transform={`translate(${PAD.l + 6},${PAD.t + 6 + i * 18})`}>
          <line x1="0" y1="6" x2="16" y2="6" stroke={color} strokeWidth="2" />
          <text x="20" y="10" fontSize="10" fill="#374151">{label} · AUC {fmt2(data.auc)} ({fmt2(data.auc_ci_lower)}–{fmt2(data.auc_ci_upper)})</text>
        </g>
      ))}
      {/* dot legend */}
      {currentDot && (
        <g transform={`translate(${PAD.l + 6},${PAD.t + 6 + splits.length * 18})`}>
          <circle cx="6" cy="6" r="5" fill="#f59e0b" stroke="#fff" strokeWidth="1.5" />
          <text x="16" y="10" fontSize="10" fill="#374151">Текущий порог ({localCutoff.toFixed(2)})</text>
        </g>
      )}
      {youdenDot && (
        <g transform={`translate(${PAD.l + 6},${PAD.t + 6 + splits.length * 18 + 18})`}>
          <circle cx="6" cy="6" r="6" fill="#059669" stroke="#fff" strokeWidth="1.5" />
          <text x="16" y="10" fontSize="10" fill="#374151">Оптимум Youden ({youdenCutoff!.toFixed(2)})</text>
        </g>
      )}
    </svg>
  );
}

// ── Sensitivity / Specificity vs Cutoff chart ─────────────────────────────────
function CutoffChart({ testMetrics, localCutoff, youdenCutoff, onApplyYouden }: {
  testMetrics: ModelingSplitMetrics;
  localCutoff: number;
  youdenCutoff: number;
  onApplyYouden: () => void;
}) {
  const W = 400, H = 170, PAD = { l: 36, r: 14, t: 10, b: 30 };
  const px = (v: number) => PAD.l + Math.min(Math.max(v, 0), 1) * (W - PAD.l - PAD.r);
  const py = (v: number) => H - PAD.b - v * (H - PAD.t - PAD.b);

  // Sort points by threshold ascending for plotting vs cutoff
  const pts = [...testMetrics.roc_curve]
    .filter((p) => p.threshold !== undefined)
    .sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0));

  if (pts.length < 2) return null;

  const sensPath = pts.map((p, i) => `${i ? "L" : "M"}${px(p.threshold!).toFixed(1)},${py(p.tpr).toFixed(1)}`).join(" ");
  const specPath = pts.map((p, i) => `${i ? "L" : "M"}${px(p.threshold!).toFixed(1)},${py(1 - p.fpr).toFixed(1)}`).join(" ");
  // Youden's J
  const joudenPath = pts.map((p, i) => `${i ? "L" : "M"}${px(p.threshold!).toFixed(1)},${py(Math.max(p.tpr + (1 - p.fpr) - 1, 0)).toFixed(1)}`).join(" ");

  // Current sens/spec at localCutoff (nearest point)
  let nearestPt = pts[0];
  let nearestDist = Infinity;
  for (const p of pts) {
    const d = Math.abs((p.threshold ?? 0) - localCutoff);
    if (d < nearestDist) { nearestDist = d; nearestPt = p; }
  }
  const curSens = nearestPt.tpr;
  const curSpec = 1 - nearestPt.fpr;

  return (
    <div className="ml-cutoff-chart">
      <div className="ml-card-title" style={{ marginBottom: 6 }}>Чувствительность и специфичность vs порог (тестовая выборка)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="ml-cutoff-svg">
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} y1={py(v)} x2={W - PAD.r} y2={py(v)} stroke="#f3f4f6" strokeWidth="1" />
            <text x={PAD.l - 5} y={py(v) + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{v.toFixed(2)}</text>
            <text x={px(v)} y={H - PAD.b + 12} textAnchor="middle" fontSize="9" fill="#9ca3af">{v.toFixed(2)}</text>
          </g>
        ))}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="#e5e7eb" strokeWidth="1" />
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#e5e7eb" strokeWidth="1" />
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#6b7280">Порог</text>
        {/* curves */}
        <path d={sensPath} fill="none" stroke="#6366f1" strokeWidth="2" />
        <path d={specPath} fill="none" stroke="#374151" strokeWidth="2" />
        <path d={joudenPath} fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="4 3" />
        {/* Youden vertical */}
        <line x1={px(youdenCutoff)} y1={PAD.t} x2={px(youdenCutoff)} y2={H - PAD.b} stroke="#059669" strokeWidth="1.5" strokeDasharray="3 2" />
        {/* Current cutoff vertical */}
        <line x1={px(localCutoff)} y1={PAD.t} x2={px(localCutoff)} y2={H - PAD.b} stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 2" />
        {/* dots at current cutoff */}
        <circle cx={px(localCutoff)} cy={py(curSens)} r="4" fill="#6366f1" stroke="#fff" strokeWidth="1.5" />
        <circle cx={px(localCutoff)} cy={py(curSpec)} r="4" fill="#374151" stroke="#fff" strokeWidth="1.5" />
        {/* legend */}
        <g transform={`translate(${W - PAD.r - 130},${PAD.t + 4})`}>
          <line x1="0" y1="5" x2="12" y2="5" stroke="#6366f1" strokeWidth="2" />
          <text x="15" y="9" fontSize="9" fill="#374151">Чувствительность</text>
          <line x1="0" y1="19" x2="12" y2="19" stroke="#374151" strokeWidth="2" />
          <text x="15" y="23" fontSize="9" fill="#374151">Специфичность</text>
          <line x1="0" y1="33" x2="12" y2="33" stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x="15" y="37" fontSize="9" fill="#9ca3af">Youden's J</text>
        </g>
      </svg>
      <div className="ml-cutoff-info-row">
        <div className="ml-cutoff-current">
          <span className="ml-cutoff-label">Текущий порог {localCutoff.toFixed(2)}:</span>
          <span className="ml-cutoff-val ml-cutoff-sens">Чувств. {pct(curSens)}</span>
          <span className="ml-cutoff-val ml-cutoff-spec">Специф. {pct(curSpec)}</span>
        </div>
        <div className="ml-cutoff-youden">
          <span className="ml-cutoff-label">Оптимум Youden's J:</span>
          <strong className="ml-cutoff-val">{youdenCutoff.toFixed(2)}</strong>
          <button className="ml-link-btn" onClick={onApplyYouden}>← Применить</button>
        </div>
      </div>
    </div>
  );
}

// ── Confusion matrix ──────────────────────────────────────────────────────────
function ConfusionMatrix({ m, label }: { m: ModelingSplitMetrics; label: string }) {
  return (
    <div className="ml-confusion">
      <div className="ml-confusion-title">{label}</div>
      <div className="ml-confusion-grid">
        <div className="ml-cm-corner">Факт ↓ / Прогноз →</div>
        <div className="ml-cm-head">Событие</div>
        <div className="ml-cm-head">Не событие</div>
        <div className="ml-cm-head ml-cm-row">Событие</div>
        <div className="ml-cm-cell ml-cm-tp"><strong>{m.tp}</strong><small>TP</small></div>
        <div className="ml-cm-cell ml-cm-err"><strong>{m.fn}</strong><small>FN</small></div>
        <div className="ml-cm-head ml-cm-row">Не событие</div>
        <div className="ml-cm-cell ml-cm-err"><strong>{m.fp}</strong><small>FP</small></div>
        <div className="ml-cm-cell ml-cm-tp"><strong>{m.tn}</strong><small>TN</small></div>
      </div>
    </div>
  );
}

// ── Metrics table ─────────────────────────────────────────────────────────────
function MetricsTable({ result, cutoff }: { result: ModelingResult; cutoff: number }) {
  const splits = [
    { key: "train" as const, label: "Обучающая" },
    { key: "test" as const, label: "Тестовая" },
    ...(result.validation ? [{ key: "validation" as const, label: "Валидационная" }] : []),
  ];
  const metrics: { label: string; fn: (m: ModelingSplitMetrics) => string }[] = [
    { label: "N", fn: (m) => String(m.n) },
    { label: "Событий", fn: (m) => String(m.n_events) },
    { label: "AUC (95% ДИ)", fn: (m) => `${fmt2(m.auc)} (${fmt2(m.auc_ci_lower)}–${fmt2(m.auc_ci_upper)})` },
    { label: "Чувствительность", fn: (m) => pct(m.sensitivity) },
    { label: "Специфичность", fn: (m) => pct(m.specificity) },
    { label: "PPV", fn: (m) => pct(m.ppv) },
    { label: "NPV", fn: (m) => pct(m.npv) },
    { label: "Диагн. эффективность", fn: (m) => pct(m.efficiency) },
  ];
  return (
    <table className="ml-metrics-table">
      <thead>
        <tr>
          <th>Метрика</th>
          {splits.map((s) => <th key={s.key}>{s.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {metrics.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            {splits.map((s) => {
              const m = result[s.key] as ModelingSplitMetrics;
              return <td key={s.key}>{row.fn(m)}</td>;
            })}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><td colSpan={splits.length + 1} className="ml-metrics-foot">Порог классификации: {cutoff.toFixed(2)}</td></tr>
      </tfoot>
    </table>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export function ModelingPage({ dataset, schema, workspace, setWorkspace }: ModelingPageProps) {
  const set = (patch: Partial<ModelingWorkspace>) =>
    setWorkspace((p) => ({ ...p, ...patch }));

  const labels = useMemo(() => Object.fromEntries(schema.map((v) => [v.name, v.label])), [schema]);
  const binaryOutcomes = useMemo(() =>
    schema.filter((v) => v.type === "binary" || (v.type === "categorical" && v.unique === 2)), [schema]);
  const allPredictors = useMemo(() =>
    schema.filter((v) => v.role !== "id" && v.type !== "text" && v.name !== workspace.outcome), [schema, workspace.outcome]);

  // ── Step 1: p-values via Table 1 API ────────────────────────────────────
  const [pLoading, setPLoading] = useState(false);
  const pAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!workspace.outcome || !allPredictors.length) {
      set({ step1PValues: {}, candidatePredictors: [] });
      return;
    }
    pAbort.current?.abort();
    const ctrl = new AbortController();
    pAbort.current = ctrl;
    setPLoading(true);
    api.tableOne(dataset.rows, workspace.outcome, allPredictors.map((v) => v.name),
      { numericPresentation: "auto", numericTest: "auto", categoricalTest: "auto", confidenceLevel: 0.95 },
      {})
      .then((res) => {
        if (ctrl.signal.aborted) return;
        const pv: Record<string, number | null> = {};
        for (const row of res.rows) pv[row.variable] = row.p_value;
        set({ step1PValues: pv });
        setPLoading(false);
      })
      .catch(() => { if (!ctrl.signal.aborted) setPLoading(false); });
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.outcome, dataset]);

  // ── Step 2: correlation ──────────────────────────────────────────────────
  const [corrResult, setCorrResult] = useState<CorrelationAnalysis | null>(null);
  const [corrLoading, setCorrLoading] = useState(false);
  const CORR_THRESHOLD = 0.7;

  const finalPredictors = workspace.candidatePredictors.filter((n) => !workspace.excludedByCorr.includes(n));

  function loadCorrelation() {
    if (finalPredictors.length < 2) return;
    setCorrLoading(true);
    api.correlation(dataset.rows, workspace.candidatePredictors, {}, "auto")
      .then((res) => { setCorrResult(res); setCorrLoading(false); })
      .catch(() => setCorrLoading(false));
  }

  // ── Step 3: training ─────────────────────────────────────────────────────
  const [trainLoading, setTrainLoading] = useState(false);
  const [trainError, setTrainError] = useState("");
  const trainAbort = useRef<AbortController | null>(null);
  const [localCutoff, setLocalCutoff] = useState(workspace.cutoff);

  function runTraining() {
    if (!workspace.outcome || !finalPredictors.length) return;
    trainAbort.current?.abort();
    const ctrl = new AbortController();
    trainAbort.current = ctrl;
    setTrainLoading(true);
    setTrainError("");
    api.modeling(dataset.rows, workspace.outcome, finalPredictors, {
      trainSize: workspace.trainSize,
      validationSize: workspace.validationSize,
      randomSeed: workspace.randomSeed,
      tuningMethod: workspace.tuningMethod,
      cvFolds: workspace.cvFolds,
      nIter: workspace.nIter,
      cutoff: localCutoff,
      confidenceLevel: 0.95,
    }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        set({ result: res, cutoff: localCutoff });
        setTrainLoading(false);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setTrainError(e instanceof Error ? e.message : "Ошибка расчёта");
        setTrainLoading(false);
      });
  }

  const goTo = (s: 1 | 2 | 3) => set({ step: s });

  // ────────────────────────────────────────────────────────────────────────
  return (
    <section className="analysis-layout lgt-layout">
      <div className="analysis-main ml-main">
        {/* Header */}
        <div className="lgt-header" style={{ marginBottom: 12 }}>
          <div className="lgt-header-left">
            <span className="eyebrow">04 · Моделирование</span>
            <h1 className="lgt-header-title">Построение модели</h1>
          </div>
          <span className="lgt-badge">ML PIPELINE</span>
        </div>

        <StepBar current={workspace.step} onGo={goTo} />

        {/* ── STEP 1 ─────────────────────────────────────────────────────── */}
        {workspace.step === 1 && (
          <div className="ml-step-body">
            <div className="ml-outcome-row">
              <label className="field" style={{ maxWidth: 360 }}>
                <span>Исход (бинарная переменная)</span>
                <select value={workspace.outcome}
                  onChange={(e) => set({ outcome: e.target.value, candidatePredictors: [], step1PValues: {}, excludedByCorr: [], result: null, step: 1 })}>
                  <option value="">— выберите переменную —</option>
                  {binaryOutcomes.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
                </select>
              </label>
              {pLoading && <span className="ml-spinner">Расчёт p-values…</span>}
            </div>

            {workspace.outcome && (
              <>
                <div className="ml-section-head">
                  <span>Доступные предикторы · {allPredictors.length}</span>
                  <button className="ml-link-btn" onClick={() => set({ candidatePredictors: allPredictors.filter((v) => (workspace.step1PValues[v.name] ?? 1) < 0.05).map((v) => v.name) })}>
                    Выбрать значимые (p &lt; 0,05)
                  </button>
                  <button className="ml-link-btn" onClick={() => set({ candidatePredictors: workspace.candidatePredictors.length === allPredictors.length ? [] : allPredictors.map((v) => v.name) })}>
                    {workspace.candidatePredictors.length === allPredictors.length ? "Снять все" : "Выбрать все"}
                  </button>
                </div>

                <div className="ml-pred-list">
                  {/* Selected first */}
                  {[
                    ...allPredictors.filter((v) => workspace.candidatePredictors.includes(v.name)),
                    ...allPredictors.filter((v) => !workspace.candidatePredictors.includes(v.name)),
                  ].map((v, idx, arr) => {
                    const isSelected = workspace.candidatePredictors.includes(v.name);
                    const prevSelected = idx > 0 && workspace.candidatePredictors.includes(arr[idx - 1].name);
                    const showDivider = !isSelected && prevSelected && workspace.candidatePredictors.length > 0;
                    const p = workspace.step1PValues[v.name] ?? null;
                    const sig = p !== null && p < 0.05;
                    return (
                      <div key={v.name}>
                        {showDivider && <div className="picker-divider"><span>Не выбраны</span></div>}
                        <label className={`ml-pred-item${isSelected ? " selected" : ""}${sig ? " sig" : ""}`}>
                          <input type="checkbox" checked={isSelected}
                            onChange={() => set({ candidatePredictors: isSelected ? workspace.candidatePredictors.filter((n) => n !== v.name) : [...workspace.candidatePredictors, v.name] })} />
                          <div className="ml-pred-info">
                            <span className="ml-pred-name">{v.label}</span>
                            <small>{v.type} · пропуски {v.missing}</small>
                          </div>
                          {pBadge(p)}
                        </label>
                      </div>
                    );
                  })}
                </div>

                <div className="ml-step-footer">
                  <span className="ml-footer-hint">Выбрано: {workspace.candidatePredictors.length} предиктор(ов)</span>
                  <button className="button primary" disabled={workspace.candidatePredictors.length < 1}
                    onClick={() => { set({ step: 2, excludedByCorr: [] }); loadCorrelation(); }}>
                    Далее: проверка корреляций →
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── STEP 2 ─────────────────────────────────────────────────────── */}
        {workspace.step === 2 && (
          <div className="ml-step-body">
            <p className="ml-step-desc">
              Проверьте высококоррелирующие пары (|r| ≥ {CORR_THRESHOLD}) и исключите одну переменную из каждой.
              Если мультиколлинеарность не вызывает опасений — пропустите этот шаг.
            </p>

            {corrLoading && <div className="ml-spinner-block">Расчёт корреляций…</div>}

            {corrResult && !corrLoading && (() => {
              const vars = workspace.candidatePredictors;
              const highPairs: { a: string; b: string; r: number }[] = [];
              for (let i = 0; i < vars.length; i++)
                for (let j = i + 1; j < vars.length; j++) {
                  const r = corrResult.matrix[vars[i]]?.[vars[j]]?.r ?? null;
                  if (r !== null && Math.abs(r) >= CORR_THRESHOLD) highPairs.push({ a: vars[i], b: vars[j], r });
                }

              return (
                <>
                  {highPairs.length === 0
                    ? <div className="ml-corr-ok">Высококоррелирующих пар не обнаружено (порог |r| ≥ {CORR_THRESHOLD}).</div>
                    : (
                      <div className="ml-corr-pairs">
                        <div className="ml-section-head">Высококоррелирующие пары · {highPairs.length}</div>
                        {highPairs.map(({ a, b, r }) => {
                          const exclA = workspace.excludedByCorr.includes(a);
                          const exclB = workspace.excludedByCorr.includes(b);
                          return (
                            <div key={`${a}-${b}`} className={`ml-corr-pair${exclA || exclB ? " resolved" : ""}`}>
                              <span className="ml-corr-r">r = {r.toFixed(2)}</span>
                              <button
                                className={`ml-corr-var${exclA ? " excluded" : ""}`}
                                onClick={() => set({ excludedByCorr: exclA ? workspace.excludedByCorr.filter((n) => n !== a) : [...workspace.excludedByCorr.filter((n) => n !== b), a] })}
                              >{labels[a] || a}</button>
                              <span className="ml-corr-sep">↔</span>
                              <button
                                className={`ml-corr-var${exclB ? " excluded" : ""}`}
                                onClick={() => set({ excludedByCorr: exclB ? workspace.excludedByCorr.filter((n) => n !== b) : [...workspace.excludedByCorr.filter((n) => n !== a), b] })}
                              >{labels[b] || b}</button>
                              <span className="ml-corr-hint">Нажмите на переменную чтобы исключить</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                  {workspace.excludedByCorr.length > 0 && (
                    <div className="ml-excluded-list">
                      Исключено: {workspace.excludedByCorr.map((n) => labels[n] || n).join(", ")}
                      <button className="ml-link-btn" onClick={() => set({ excludedByCorr: [] })}>Восстановить все</button>
                    </div>
                  )}
                </>
              );
            })()}

            <div className="ml-step-footer">
              <button className="button secondary" onClick={() => set({ step: 1 })}>← Назад</button>
              <span className="ml-footer-hint">Итого предикторов: {finalPredictors.length}</span>
              <button className="button primary" disabled={finalPredictors.length < 1}
                onClick={() => set({ step: 3, result: null })}>
                Далее: обучение модели →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3 ─────────────────────────────────────────────────────── */}
        {workspace.step === 3 && (
          <div className="ml-step-body ml-step3">
            <div className="ml-step3-layout">
              {/* Config panel */}
              <aside className="ml-config-panel">
                <div className="ml-config-section">
                  <div className="ml-config-title">Разделение выборки</div>
                  <label className="ml-slider-field">
                    <span>Обучающая: <strong>{Math.round(workspace.trainSize * 100)}%</strong></span>
                    <input type="range" min="0.5" max="0.9" step="0.05" value={workspace.trainSize}
                      onChange={(e) => set({ trainSize: Number(e.target.value) })} />
                  </label>
                  <label className="ml-slider-field">
                    <span>Внешняя валидация: <strong>{Math.round(workspace.validationSize * 100)}%</strong></span>
                    <input type="range" min="0" max="0.3" step="0.05" value={workspace.validationSize}
                      onChange={(e) => set({ validationSize: Number(e.target.value) })} />
                  </label>
                  <div className="ml-split-preview">
                    <div className="ml-split-seg ml-seg-train" style={{ flex: workspace.trainSize }}>
                      Обучение {Math.round(workspace.trainSize * 100)}%
                    </div>
                    <div className="ml-split-seg ml-seg-test" style={{ flex: 1 - workspace.trainSize - workspace.validationSize }}>
                      Тест {Math.round((1 - workspace.trainSize - workspace.validationSize) * 100)}%
                    </div>
                    {workspace.validationSize > 0 && (
                      <div className="ml-split-seg ml-seg-val" style={{ flex: workspace.validationSize }}>
                        Вал. {Math.round(workspace.validationSize * 100)}%
                      </div>
                    )}
                  </div>
                </div>

                <div className="ml-config-section">
                  <div className="ml-config-title">Подбор гиперпараметров</div>
                  <div className="ml-radio-group">
                    {([["none", "Без подбора"], ["grid", "Grid Search"], ["random", "Random Search"]] as const).map(([val, lbl]) => (
                      <label key={val} className="ml-radio">
                        <input type="radio" name="tuning" value={val} checked={workspace.tuningMethod === val}
                          onChange={() => set({ tuningMethod: val })} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                  {workspace.tuningMethod !== "none" && (
                    <label className="ml-slider-field">
                      <span>CV fold: <strong>{workspace.cvFolds}</strong></span>
                      <input type="range" min="2" max="10" step="1" value={workspace.cvFolds}
                        onChange={(e) => set({ cvFolds: Number(e.target.value) })} />
                    </label>
                  )}
                  {workspace.tuningMethod === "random" && (
                    <label className="ml-slider-field">
                      <span>Итераций: <strong>{workspace.nIter}</strong></span>
                      <input type="range" min="5" max="50" step="5" value={workspace.nIter}
                        onChange={(e) => set({ nIter: Number(e.target.value) })} />
                    </label>
                  )}
                </div>

                <div className="ml-config-section">
                  <div className="ml-config-title">Прочее</div>
                  <label className="ml-slider-field">
                    <span>Cutoff: <strong>{localCutoff.toFixed(2)}</strong></span>
                    <input type="range" min="0.1" max="0.9" step="0.01" value={localCutoff}
                      onChange={(e) => setLocalCutoff(Number(e.target.value))} />
                  </label>
                  <label className="ml-number-field">
                    <span>Random seed</span>
                    <input type="number" value={workspace.randomSeed} min={0} max={99999}
                      onChange={(e) => set({ randomSeed: Number(e.target.value) })} />
                  </label>
                </div>

                <div className="ml-config-section">
                  <div className="ml-config-title">Предикторы ({finalPredictors.length})</div>
                  <div className="ml-pred-chips">
                    {finalPredictors.map((n) => <span key={n} className="ml-pred-chip">{labels[n] || n}</span>)}
                  </div>
                </div>

                <button className="button primary ml-run-btn" onClick={runTraining} disabled={trainLoading}>
                  {trainLoading ? "Обучение…" : workspace.result ? "Переобучить" : "Обучить модель"}
                </button>
                {trainError && <div className="ml-error">{trainError}</div>}
                <button className="button secondary" style={{ marginTop: 8 }} onClick={() => set({ step: 2 })}>← Назад</button>
              </aside>

              {/* Results */}
              <div className="ml-results">
                {!workspace.result && !trainLoading && (
                  <div className="regression-empty"><span>◈</span><h2>Настройте параметры и запустите обучение</h2></div>
                )}
                {trainLoading && (
                  <div className="regression-empty"><span className="ml-spinner-icon">⟳</span><h2>Обучаю модель…</h2><p>Это может занять несколько секунд{workspace.tuningMethod !== "none" ? ` (подбор гиперпараметров, ${workspace.cvFolds}-fold CV)` : ""}.</p></div>
                )}
                {workspace.result && !trainLoading && (() => {
                  const r = workspace.result;
                  const rocSplits = [
                    { label: "Обучение", color: "#6366f1", data: r.train },
                    { label: "Тест", color: "#1f2937", data: r.test },
                    ...(r.validation ? [{ label: "Валидация", color: "#059669", data: r.validation! }] : []),
                  ];
                  return (
                    <>
                      {r.warnings.map((w) => <div key={w} className="regression-warning"><strong>⚠</strong><span>{w}</span></div>)}

                      {r.best_params && (
                        <div className="ml-best-params">
                          <strong>Лучшие гиперпараметры ({r.tuning_method === "grid" ? "Grid Search" : "Random Search"}, {r.cv_folds}-fold CV):</strong>{" "}
                          {Object.entries(r.best_params).map(([k, v]) => `${k} = ${v}`).join(", ")}
                        </div>
                      )}

                      <div className="ml-results-grid">
                        <div className="ml-card ml-card-roc">
                          <div className="ml-card-title">ROC-кривые</div>
                          <RocChart splits={rocSplits} localCutoff={localCutoff} youdenCutoff={r.youden_cutoff} />
                          <CutoffChart
                            testMetrics={r.test}
                            localCutoff={localCutoff}
                            youdenCutoff={r.youden_cutoff}
                            onApplyYouden={() => setLocalCutoff(r.youden_cutoff)}
                          />
                        </div>

                        <div className="ml-card ml-card-metrics">
                          <div className="ml-card-title">Метрики качества</div>
                          <MetricsTable result={r} cutoff={localCutoff} />
                        </div>

                        <div className="ml-card ml-card-confusion">
                          <div className="ml-card-title">Матрицы ошибок</div>
                          <div className="ml-confusion-row">
                            <ConfusionMatrix m={r.train} label="Обучение" />
                            <ConfusionMatrix m={r.test} label="Тест" />
                            {r.validation && <ConfusionMatrix m={r.validation} label="Валидация" />}
                          </div>
                        </div>

                        <div className="ml-card ml-card-coef">
                          <div className="ml-card-title">Коэффициенты модели</div>
                          <table className="ml-coef-table">
                            <thead>
                              <tr><th>Предиктор</th><th>OR</th><th>{Math.round(0.95 * 100)}% ДИ</th><th>p-value</th></tr>
                            </thead>
                            <tbody>
                              {r.coefficients.map((c) => (
                                <tr key={c.term}>
                                  <td>{labels[c.term] || c.term}</td>
                                  <td>{c.or.toFixed(3)}</td>
                                  <td>{c.ci_lower.toFixed(3)} – {c.ci_upper.toFixed(3)}</td>
                                  <td className={c.p_value < 0.05 ? "significant" : ""}>{c.p_display}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
