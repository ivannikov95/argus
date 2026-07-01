import { useState } from "react";
import type { Dataset } from "../types";
import { formatValue } from "../utils";

const DS_PAGE_SIZE = 50;

export interface DatasetPageProps {
  dataset: Dataset;
  onUpload: () => void;
  onOpenVariables: () => void;
  onEditCell: (rowIdx: number, col: string, value: string) => void;
}

export function DatasetPage({ dataset, onUpload, onOpenVariables, onEditCell }: DatasetPageProps) {
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

export default DatasetPage;
