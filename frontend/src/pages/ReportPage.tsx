import { Fragment, useMemo } from "react";
import type { Dataset, VariableSchema, TableSlide, RegressionWorkspace, CorrelationWorkspace } from "../types";
import { ScatterPreviewImage } from "../components/ScatterPreviewImage";

export interface ReportPreviewPageProps {
  slides: TableSlide[];
  schema: VariableSchema[];
  dataset: Dataset | null;
  regression: RegressionWorkspace;
  correlation: CorrelationWorkspace;
  setCorrelation: (w: CorrelationWorkspace | ((p: CorrelationWorkspace) => CorrelationWorkspace)) => void;
  onExport: () => void;
}

export function ReportPreviewPage({ slides, schema, dataset, regression, correlation, setCorrelation, onExport }: ReportPreviewPageProps) {
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
            <div className="table-scroll"><table className="report-preview-table"><thead><tr><th>Показатель</th>{slide.settings.showOverall && <th>Все (n={analysis.n})</th>}{(() => { const slots = slide.groupSlots.length === analysis.groups.length && slide.groupSlots.length > 0 ? slide.groupSlots : analysis.groups.map(g => ({ rawValue: g.name, label: g.name })); return slots.map(slot => { const g = analysis.groups.find(g => g.name === slot.rawValue); return <th key={slot.rawValue}>{slot.label}<small>n={g?.n ?? 0}</small></th>; }); })()}<th>p-value</th></tr></thead><tbody>
              {(() => { const slots = slide.groupSlots.length === analysis.groups.length && slide.groupSlots.length > 0 ? slide.groupSlots : analysis.groups.map(g => ({ rawValue: g.name, label: g.name })); return analysis.rows.map((row) => <Fragment key={row.variable}><tr><td>{labels[row.variable] || row.variable}<small>{row.presentation}</small></td>{slide.settings.showOverall && <td>{row.overall}</td>}{slots.map(slot => <td key={slot.rawValue}>{row.groups[slot.rawValue]}</td>)}<td>{row.p_display}</td></tr>{row.levels.map((level) => <tr className="category-level" key={`${row.variable}-${level.level}`}><td>↳ {level.level}</td>{slide.settings.showOverall && <td>{level.overall}</td>}{slots.map(slot => <td key={slot.rawValue}>{level.groups[slot.rawValue]}</td>)}<td /></tr>)}</Fragment>); })()}
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

export default ReportPreviewPage;
