import type { Dataset, TableEditorSettings, TableSlide, RegressionWorkspace } from "./types";

export const DEFAULT_SETTINGS: TableEditorSettings = {
  title: "Таблица 1 - Базовые характеристики исследуемой выборки",
  description: "",
  footnotes: "",
  font: "times",
  fontSize: 11,
  alignment: "left",
  decimals: 1,
  pFormat: "exact",
  showOverall: true,
  showEffect: true,
  showCI: true,
  showMissing: true,
  decomposeCategories: false,
  numericPresentation: "auto",
  numericTest: "auto",
  categoricalTest: "auto",
  confidenceLevel: 0.95,
};

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function formatTableCaption(value: string, num = 1) {
  const title = value.trim();
  if (!title) return `Таблица ${num} - Без названия`;
  if (/^Таблица\s+\d+\s*[-–—]/i.test(title)) return title.replace(/^(Таблица\s+\d+)\s*[-–—]\s*/i, "$1 - ");
  return `Таблица ${num} - ${title}`;
}

export function makeSlide(overrides: Partial<TableSlide> & { id: string }): TableSlide {
  return { group: null, groupSlots: [], selected: [], settings: { ...DEFAULT_SETTINGS }, analysis: null, ...overrides };
}

export function slidesForDataset(dataset: Dataset) {
  const suggestedGroup =
    dataset.schema.find((v) => v.name.toLowerCase().includes("group") && v.unique <= 8)?.name ??
    dataset.schema.find((v) => ["binary", "categorical"].includes(v.type) && v.role !== "id" && v.unique <= 8)?.name ??
    null;
  return [makeSlide({ id: "s1", group: suggestedGroup })];
}

export function regressionForDataset(dataset: Dataset): RegressionWorkspace {
  const eligible = dataset.schema.filter((v) => v.role !== "id" && (v.type === "numeric" || v.type === "binary"));
  return {
    outcome: eligible.find((v) => v.role === "outcome")?.name ?? eligible.find((v) => v.type === "binary")?.name ?? eligible[0]?.name ?? "",
    predictors: [],
    confidenceLevel: 0.95,
    cutoff: 0.5,
    result: null,
  };
}

export function formatOR(or: number, lo: number, hi: number): string {
  const f = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${f(or)} (${f(lo)}–${f(hi)})`;
}

export function toRoman(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ["M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"];
  let r = "", i = 0;
  while (n > 0) { while (n >= vals[i]) { r += syms[i]; n -= vals[i]; } i++; }
  return r;
}

export function corrDirection(r: number): string { return r >= 0 ? "Прямая" : "Обратная"; }

export function corrStrengthWord(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.9) return "очень сильная";
  if (a >= 0.7) return "сильная";
  if (a >= 0.5) return "умеренная";
  if (a >= 0.3) return "слабая";
  return "очень слабая";
}

export function formatPExact(p: number | null): string {
  if (p === null) return "—";
  if (p < 0.001) return "< 0,001";
  return p.toFixed(3).replace(".", ",");
}

export function corrColor(r: number | null): string {
  if (r === null || isNaN(r)) return "#f0f2f5";
  const abs = Math.abs(r);
  return r >= 0
    ? `hsl(217,${Math.round(abs * 75)}%,${Math.round(100 - abs * 36)}%)`
    : `hsl(350,${Math.round(abs * 75)}%,${Math.round(100 - abs * 36)}%)`;
}
