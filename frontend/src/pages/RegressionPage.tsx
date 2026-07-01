import { useState, useEffect, useMemo } from "react";
import { api } from "../api";
import type { Dataset, VariableSchema, RegressionWorkspace } from "../types";

export interface RegressionPageProps {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: RegressionWorkspace;
  setWorkspace: (value: RegressionWorkspace | ((current: RegressionWorkspace) => RegressionWorkspace)) => void;
  onOpenReport: () => void;
}

export function RegressionPage({ dataset, schema, workspace, setWorkspace, onOpenReport }: RegressionPageProps) {
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

export default RegressionPage;
