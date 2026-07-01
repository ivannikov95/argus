import { useState, useEffect } from "react";
import { api } from "../api";
import type { Dataset, VariableSchema, CorrelationAnalysis } from "../types";

export interface ScatterPreviewImageProps {
  pair: { row: string; col: string };
  dataset: Dataset;
  schema: VariableSchema[];
  result: CorrelationAnalysis;
}

export function ScatterPreviewImage({ pair, dataset, schema, result }: ScatterPreviewImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objUrl: string | null = null;
    const xSch = schema.find((s) => s.name === pair.col);
    const ySch = schema.find((s) => s.name === pair.row);
    const xValues = dataset.rows.map((r) => { const v = r[pair.col]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; });
    const yValues = dataset.rows.map((r) => { const v = r[pair.row]; const n = typeof v === "string" ? parseFloat(v) : (v as number); return isNaN(n) ? null : n; });
    const cell = result.matrix[pair.row]?.[pair.col];
    api.scatterUrl(xValues, yValues, xSch?.label ?? pair.col, ySch?.label ?? pair.row, cell?.r ?? null, cell?.stars ?? "", result.method)
      .then((u) => { objUrl = u; setUrl(u); })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.row, pair.col]);

  if (loading) return <div className="scatter-preview-loading"><span className="spinner" /></div>;
  if (!url) return null;
  return <img src={url} className="scatter-preview-img" alt={`${pair.col} vs ${pair.row}`} />;
}

export default ScatterPreviewImage;
