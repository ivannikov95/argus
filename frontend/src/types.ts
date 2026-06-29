export type VariableType = "numeric" | "categorical" | "binary" | "text";

export interface VariableSchema {
  name: string;
  label: string;
  type: VariableType;
  role: "id" | "feature" | "outcome" | "group";
  count: number;
  missing: number;
  missing_percent: number;
  unique: number;
  examples: unknown[];
}

export interface Dataset {
  file_name: string;
  row_count: number;
  column_count: number;
  missing_count: number;
  duplicate_count: number;
  schema: VariableSchema[];
  rows: Record<string, unknown>[];
}

export interface AnalysisRow {
  variable: string;
  type: string;
  presentation: string;
  overall: string;
  groups: Record<string, string>;
  missing: number;
  test: string;
  p_value: number | null;
  p_display: string;
  effect: string;
  effect_label: string;
  ci_display: string;
  ci_label: string;
  normality: string;
  levels: { level: string; overall: string; groups: Record<string, string> }[];
}

export interface TableOneAnalysis {
  n: number;
  group_column: string | null;
  groups: { name: string; n: number }[];
  rows: AnalysisRow[];
  note: string;
  generated_at: string;
}
