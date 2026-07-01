import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Dataset, VariableSchema, CorrelationAnalysis } from "../types";
import { corrDirection, corrStrengthWord, formatPExact } from "../utils";

export interface CorrelationModalProps {
  dataset: Dataset;
  schema: VariableSchema[];
  labels: Record<string, string>;
  cell: { row: string; col: string };
  result: CorrelationAnalysis;
  inReport: boolean;
  onToggleReport: () => void;
  onClose: () => void;
}

export function CorrelationModal({ dataset, schema, labels, cell, result, inReport, onToggleReport, onClose }: CorrelationModalProps) {
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

export default CorrelationModal;
