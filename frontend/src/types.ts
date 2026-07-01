export type VariableType = "numeric" | "categorical" | "binary" | "text";

export interface GroupSlot { label: string; rawValue: string; }

export interface TableEditorSettings {
  title: string;
  description: string;
  footnotes: string;
  font: "times";
  fontSize: 10 | 11 | 12;
  alignment: "left" | "center" | "right";
  decimals: number;
  pFormat: "exact" | "threshold";
  showEffect: boolean;
  showOverall: boolean;
  showCI: boolean;
  showMissing: boolean;
  decomposeCategories: boolean;
  numericPresentation: "auto" | "mean_sd" | "median_iqr";
  numericTest: "auto" | "parametric" | "nonparametric";
  categoricalTest: "auto" | "chi_square" | "fisher";
  confidenceLevel: 0.90 | 0.95 | 0.99;
}

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

export interface RegressionCoefficient {
  term: string;
  estimate: number;
  standard_error: number;
  p_value: number;
  p_display: string;
  ci_lower: number;
  ci_upper: number;
  effect: number;
  effect_ci_lower: number;
  effect_ci_upper: number;
}

export interface CorrelationCell {
  r: number | null;
  p: number | null;
  n: number;
  stars: string;
}

export interface CorrelationAnalysis {
  method: "pearson" | "spearman";
  variables: string[];
  labels: Record<string, string>;
  matrix: Record<string, Record<string, CorrelationCell>>;
  n: number;
  generated_at: string;
}

export interface RegressionAnalysis {
  model_type: "linear" | "logistic";
  fit_method: "ols" | "mle" | "firth";
  warnings: string[];
  outcome: string;
  event_level: string | null;
  n: number;
  excluded: number;
  confidence_level: number;
  references: string[];
  coefficients: RegressionCoefficient[];
  metrics: Record<string, number>;
  diagnostics: {
    auc: number;
    roc_curve: { fpr: number; tpr: number; threshold: number }[];
    predictions: { actual: 0 | 1; probability: number }[];
  } | null;
  generated_at: string;
}

export interface LogisticCoeff {
  or: number;
  ci_lower: number;
  ci_upper: number;
  p_value: number;
  p_display: string;
}

export interface LogisticUniResult extends LogisticCoeff {
  n: number;
  n_events: number;
}

export interface LogisticMultiResult {
  coefficients: Record<string, LogisticCoeff & { term: string }>;
  n: number;
  n_events: number;
  chi2: number;
  chi2_p: number;
  chi2_p_display: string;
  nagelkerke_r2: number;
  fit_method: string;
  warnings: string[];
}

export interface LogisticTableRow {
  predictor: string;
  inMultivariate: boolean;
  univariate: LogisticUniResult | null;
  univariateLoading: boolean;
  univariateError: string | null;
}

export interface TableSlide {
  id: string;
  group: string | null;
  groupSlots: GroupSlot[];
  selected: string[];
  settings: TableEditorSettings;
  analysis: TableOneAnalysis | null;
}

export interface LogisticTableWorkspace {
  outcome: string;
  rows: LogisticTableRow[];
  multiResult: LogisticMultiResult | null;
  multiLoading: boolean;
}

export interface CorrelationWorkspace {
  variables: string[];
  method: "auto" | "pearson" | "spearman";
  result: CorrelationAnalysis | null;
  includeMatrix: boolean;
  reportPairs: { row: string; col: string }[];
}

export interface RegressionWorkspace {
  outcome: string;
  predictors: string[];
  confidenceLevel: number;
  cutoff: number;
  result: RegressionAnalysis | null;
}
