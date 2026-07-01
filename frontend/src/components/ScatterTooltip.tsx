import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Dataset, VariableSchema, CorrelationAnalysis } from "../types";

interface HoveredCell { row: string; col: string; rectRight: number; rectTop: number; }

export interface ScatterTooltipProps {
  dataset: Dataset;
  schema: VariableSchema[];
  labels: Record<string, string>;
  hovered: HoveredCell;
  result: CorrelationAnalysis;
  method: string;
}

export function ScatterTooltip({ dataset, schema, labels, hovered, result, method }: ScatterTooltipProps) {
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

export default ScatterTooltip;
