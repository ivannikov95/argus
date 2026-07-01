import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";
import type { Dataset, VariableSchema, CorrelationWorkspace } from "../types";
import { corrColor } from "../utils";
import { ScatterTooltip } from "../components/ScatterTooltip";
import { CorrelationModal } from "../components/CorrelationModal";

interface HoveredCell { row: string; col: string; rectRight: number; rectTop: number; }

export interface CorrelationPageProps {
  dataset: Dataset;
  schema: VariableSchema[];
  workspace: CorrelationWorkspace;
  setWorkspace: (w: CorrelationWorkspace | ((p: CorrelationWorkspace) => CorrelationWorkspace)) => void;
}

export function CorrelationPage({ dataset, schema, workspace, setWorkspace }: CorrelationPageProps) {
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
            <div className="picker-scroll">
              {eligible.map((v) => (
                <div key={v.name} className={`variable-choice${variables.includes(v.name) ? " selected" : ""}`}>
                  <label>
                    <input type="checkbox" checked={variables.includes(v.name)} onChange={() => toggle(v.name)} />
                    <span>{v.label}<small>{v.type} · пропуски {v.missing}</small></span>
                  </label>
                </div>
              ))}
            </div>
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

export default CorrelationPage;
