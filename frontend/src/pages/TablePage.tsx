import { Fragment, type PointerEvent as ReactPointerEvent, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { AnalysisRow, Dataset, VariableSchema, TableOneAnalysis, TableEditorSettings, GroupSlot } from "../types";
import { toRoman, formatTableCaption } from "../utils";

export interface TablePageProps {
  dataset: Dataset;
  schema: VariableSchema[];
  candidateGroups: VariableSchema[];
  group: string | null;
  setGroup: (v: string | null) => void;
  groupSlots: GroupSlot[];
  setGroupSlots: (v: GroupSlot[]) => void;
  selected: string[];
  setSelected: (v: string[]) => void;
  analysis: TableOneAnalysis | null;
  settings: TableEditorSettings;
  setSettings: (s: TableEditorSettings) => void;
  onExport: () => void;
  onExportReport: () => void;
  slideIndex: number;
  slideCount: number;
  computedCount: number;
  onPrevSlide: () => void;
  onNextSlide: () => void;
  onAddSlide: () => void;
  onDeleteSlide: () => void;
}

export function TablePage({
  dataset, schema, candidateGroups, group, setGroup, groupSlots, setGroupSlots, selected, setSelected,
  analysis, settings, setSettings, onExport, onExportReport,
  slideIndex, slideCount, computedCount, onPrevSlide, onNextSlide, onAddSlide, onDeleteSlide,
}: TablePageProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ name: string; edge: "before" | "after" } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number; width: number } | null>(null);
  const [pickerOrder, setPickerOrder] = useState<string[]>(() => schema.map((v) => v.name));
  const draggedRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ name: string; edge: "before" | "after" } | null>(null);
  const variableRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bgAbortRef = useRef<AbortController | null>(null);
  const [bgPValues, setBgPValues] = useState<Map<string, number | null>>(new Map());
  const labels = Object.fromEntries(schema.map((item) => [item.name, item.label]));
  const available = schema.filter((v) => v.role !== "id" && v.type !== "text" && v.name !== group);
  const availableNames = new Set(available.map((v) => v.name));
  // Selected vars float to top (in analysis order), unselected below
  const selectedVars = selected
    .map((name) => available.find((v) => v.name === name))
    .filter((v): v is VariableSchema => Boolean(v));
  const unselectedVars = [
    ...pickerOrder.filter((name) => !selected.includes(name)).map((name) => available.find((v) => v.name === name)).filter((v): v is VariableSchema => Boolean(v)),
    ...available.filter((v) => !selected.includes(v.name) && !pickerOrder.includes(v.name)),
  ];
  const pickerVariables = [...selectedVars, ...unselectedVars];
  // Background p-value scan: all available variables whenever group changes
  useEffect(() => {
    if (!group) { setBgPValues(new Map()); return; }
    bgAbortRef.current?.abort();
    const ctrl = new AbortController();
    bgAbortRef.current = ctrl;
    const allNames = available.map((v) => v.name);
    if (!allNames.length) return;
    api.tableOne(
      dataset.rows, group, allNames,
      { numericPresentation: settings.numericPresentation, numericTest: settings.numericTest, categoricalTest: settings.categoricalTest, confidenceLevel: settings.confidenceLevel },
      Object.fromEntries(schema.map((v) => [v.name, v])),
    ).then((res) => {
      if (ctrl.signal.aborted) return;
      setBgPValues(new Map(res.rows.map((r) => [r.variable, r.p_value])));
    }).catch(() => {});
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, dataset]);

  // Auto-populate groupSlots when first analysis with groups arrives
  useEffect(() => {
    if (groupSlots.length === 0 && (analysis?.groups.length ?? 0) > 0) {
      setGroupSlots(analysis!.groups.map((g, i) => ({ label: `Группа ${toRoman(i + 1)}`, rawValue: g.name })));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  // Effective display order: slots if valid, else raw analysis order
  const effectiveSlots: GroupSlot[] = (groupSlots.length === (analysis?.groups.length ?? 0) && groupSlots.length > 0)
    ? groupSlots
    : (analysis?.groups.map(g => ({ rawValue: g.name, label: g.name })) ?? []);

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
          <div className="heading-title-wrap"><span className="eyebrow">03 · Описательная статистика</span><div className="heading-title-input" contentEditable suppressContentEditableWarning onBlur={(e) => { const val = e.currentTarget.textContent?.trim() || ""; updateSettings({ title: formatTableCaption(val || settings.title, slideIndex + 1) }); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} ref={(el) => { if (el && el.textContent !== settings.title) el.textContent = settings.title; }} aria-label="Заголовок таблицы" /><p>Представление, тест и размер эффекта фиксируются для каждой переменной.</p></div>
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
              <div className="table-scroll"><table className="result-table"><thead><tr><th>Показатель</th>{settings.showOverall && <th>Все (n={analysis.n})</th>}{effectiveSlots.map(slot => { const g = analysis.groups.find(g => g.name === slot.rawValue); return <th key={slot.rawValue}>{slot.label}<small>n={g?.n ?? 0}</small></th>; })}{settings.showMissing && <th>Пропуски</th>}{settings.showCI && <th>95% ДИ</th>}<th>p-value</th>{settings.showEffect && <th>Эффект</th>}</tr></thead><tbody>{visibleRows.map((row) => <Fragment key={row.variable}><tr><td><strong>{labels[row.variable] || row.variable}</strong><small>{presShort(row.presentation)}</small></td>{settings.showOverall && <td>{row.levels.length ? "" : formatStat(row.overall)}</td>}{effectiveSlots.map(slot => <td key={slot.rawValue}>{row.levels.length ? "" : formatStat(row.groups[slot.rawValue])}</td>)}{settings.showMissing && <td>{row.missing}</td>}{settings.showCI && <td>{formatStat(row.ci_display)}<small>{row.ci_label}</small></td>}<td className={row.p_value !== null && row.p_value < 0.05 ? "significant" : ""}>{formatP(row)}</td>{settings.showEffect && <td>{formatStat(row.effect)}<small>{row.effect_label}</small></td>}</tr>{row.levels.map((level) => <tr className="category-level" key={`${row.variable}-${level.level}`}><td>↳ {level.level}</td>{settings.showOverall && <td>{formatStat(level.overall)}</td>}{effectiveSlots.map(slot => <td key={slot.rawValue}>{formatStat(level.groups[slot.rawValue])}</td>)}{settings.showMissing && <td />}{settings.showCI && <td />}<td />{settings.showEffect && <td />}</tr>)}</Fragment>)}</tbody></table></div>
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
        {group && effectiveSlots.length > 0 && (
          <div className="group-label-editor">
            <span className="group-label-editor-title">Распределение групп</span>
            {effectiveSlots.map((slot, i) => (
              <div key={i} className="group-label-row">
                <input
                  className="group-label-name-input"
                  type="text"
                  value={slot.label}
                  onChange={(e) => {
                    const next = [...groupSlots];
                    next[i] = { ...slot, label: e.target.value };
                    setGroupSlots(next);
                  }}
                />
                <span className="group-label-arrow">←</span>
                <select
                  className="group-label-select"
                  value={slot.rawValue}
                  onChange={(e) => {
                    const newRaw = e.target.value;
                    const next = groupSlots.map((s, j) => {
                      if (j === i) return { ...s, rawValue: newRaw };
                      if (s.rawValue === newRaw) return { ...s, rawValue: slot.rawValue };
                      return s;
                    });
                    setGroupSlots(next);
                  }}
                >
                  {analysis?.groups.map(g => (
                    <option key={g.name} value={g.name}>{g.name} (n={g.n})</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        <div className={`variable-picker ${dragged ? "is-reordering" : ""}`}>
          <div className="picker-head"><span>Переменные · {selected.filter((name) => availableNames.has(name)).length} выбрано</span><button onClick={() => setSelected(selected.filter((name) => availableNames.has(name)).length === available.length ? [] : available.map((v) => v.name))}>{selected.filter((name) => availableNames.has(name)).length === available.length ? "Снять все" : "Выбрать все"}</button></div>
          <p className="picker-hint">Отмечайте строки и перетаскивайте выбранные переменные за маркер.</p>
          <div className="picker-scroll">
            {(() => {
              const hasGroups = !!group;
              return pickerVariables.map((variable, idx) => {
                const isSelected = selected.includes(variable.name);
                const showDivider = idx === selectedVars.length && selectedVars.length > 0 && unselectedVars.length > 0;
                const position = selected.indexOf(variable.name);
                const hintClass = dropHint?.name === variable.name && dragged !== variable.name ? `drop-${dropHint.edge}` : "";
                const pVal = hasGroups ? bgPValues.get(variable.name) : undefined;
                const isSig = pVal !== undefined && pVal !== null && pVal < 0.05;
                return (
                  <div key={variable.name}>
                  {showDivider && <div className="picker-divider"><span>Не выбраны</span></div>}
                  <div className={`variable-choice ${isSelected ? "selected" : ""} ${dragged === variable.name ? "dragging" : ""} ${hintClass}`} ref={(el) => { variableRefs.current[variable.name] = el; }}>
                    <button type="button" className="drag-handle" disabled={!isSelected} aria-label={`Перетащить ${variable.label}`} onPointerDown={(e) => startPointerDrag(e, variable.name)} onPointerMove={movePointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => clearPointerDrag()}>⠿</button>
                    <label>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleVariable(variable.name)} />
                      <span>
                        {variable.label}
                        <small>{variable.type} · пропуски {variable.missing}</small>
                      </span>
                    </label>
                    {pVal !== undefined && pVal !== null && (
                      <span className={`picker-p-badge${isSig ? " picker-p-badge--sig" : " picker-p-badge--ns"}`} title={`p = ${pVal}`}>
                        {isSig ? (pVal < 0.001 ? "p<0,001" : "p<0,05") : "p>0,05"}
                      </span>
                    )}
                    <div className="reorder-buttons">
                      <button disabled={!isSelected || position === 0} onClick={() => moveVariable(variable.name, -1)} aria-label={`Поднять ${variable.label}`}>↑</button>
                      <button disabled={!isSelected || position === selected.length - 1} onClick={() => moveVariable(variable.name, 1)} aria-label={`Опустить ${variable.label}`}>↓</button>
                    </div>
                  </div>
                  </div>
                );
              });
            })()}
          </div>
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

export default TablePage;
