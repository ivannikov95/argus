import type { CorrelationAnalysis, Dataset, LogisticMultiResult, LogisticUniResult, RegressionAnalysis, TableOneAnalysis } from "./types";

export interface ProjectMeta {
  project_id: string;
  project_name: string;
  file_name: string;
  saved_at: string;
}

export interface SavedProject extends ProjectMeta {
  rows: Record<string, unknown>[];
  variable_overrides: Record<string, unknown>;
  slides: Array<{
    id: string;
    group: string | null;
    selected: string[];
    settings: Record<string, unknown>;
    analysis: TableOneAnalysis | null;
  }>;
  last_analysis: TableOneAnalysis | null;  // backward compat
  table_settings: Record<string, unknown>;  // backward compat
  regression?: {
    outcome: string;
    predictors: string[];
    confidenceLevel: number;
    cutoff: number;
    result: RegressionAnalysis | null;
  };
}

export interface ExportOptions {
  title: string;
  description: string;
  footnotes: string;
  showOverall: boolean;
  showEffect: boolean;
  showCI: boolean;
  showMissing: boolean;
  decomposeCategories: boolean;
  analysis: TableOneAnalysis;
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Ошибка сервера" }));
    throw new Error(error.detail || "Ошибка сервера");
  }
  return response.json() as Promise<T>;
}

function buildExportBody(options: ExportOptions) {
  return {
    title: options.title,
    description: options.description,
    footnotes: options.footnotes,
    show_overall: options.showOverall,
    show_effect: options.showEffect,
    show_ci: options.showCI,
    show_missing: options.showMissing,
    decompose_categories: options.decomposeCategories,
    analysis: options.analysis,
  };
}

export const api = {
  demo: () => fetch("/api/demo-data").then(parse<Dataset>),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/dataset/import", { method: "POST", body: form }).then(parse<Dataset>);
  },

  profileDataset: (rows: Record<string, unknown>[], fileName: string) =>
    fetch("/api/dataset/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, file_name: fileName }),
    }).then(parse<Dataset>),

  tableOne: (
    rows: Record<string, unknown>[],
    groupColumn: string | null,
    variables: string[],
    options: { numericPresentation: string; numericTest: string; categoricalTest: string; confidenceLevel: number },
    variableOverrides: Record<string, unknown> = {},
  ) =>
    fetch("/api/analyze/table-one", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows,
        group_column: groupColumn,
        variables,
        variable_overrides: variableOverrides,
        numeric_presentation: options.numericPresentation,
        numeric_test: options.numericTest,
        categorical_test: options.categoricalTest,
        confidence_level: options.confidenceLevel,
      }),
    }).then(parse<TableOneAnalysis>),

  regression: (
    rows: Record<string, unknown>[],
    outcome: string,
    predictors: string[],
    variableOverrides: Record<string, unknown> = {},
    confidenceLevel = 0.95,
    signal?: AbortSignal,
  ) =>
    fetch("/api/analyze/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        rows,
        outcome,
        predictors,
        variable_overrides: variableOverrides,
        confidence_level: confidenceLevel,
      }),
    }).then(parse<RegressionAnalysis>),

  correlation: (
    rows: Record<string, unknown>[],
    variables: string[],
    variableOverrides: Record<string, unknown> = {},
    method: "auto" | "pearson" | "spearman" = "auto",
    signal?: AbortSignal,
  ) =>
    fetch("/api/analyze/correlation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ rows, variables, variable_overrides: variableOverrides, method }),
    }).then(parse<CorrelationAnalysis>),

  scatterUrl: (
    xValues: (number | null)[],
    yValues: (number | null)[],
    xLabel: string,
    yLabel: string,
    r: number | null,
    stars: string,
    method: string,
  ): Promise<string> =>
    fetch("/api/plot/scatter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x_values: xValues, y_values: yValues, x_label: xLabel, y_label: yLabel, r, stars, method }),
    }).then(async (res) => {
      if (!res.ok) throw new Error("Ошибка графика");
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    }),

  logisticUnivariate: (
    rows: Record<string, unknown>[],
    outcome: string,
    predictors: string[],
    variableOverrides: Record<string, unknown> = {},
    confidenceLevel = 0.95,
    signal?: AbortSignal,
  ) =>
    fetch("/api/analyze/logistic-univariate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ rows, outcome, predictors, variable_overrides: variableOverrides, confidence_level: confidenceLevel }),
    }).then(parse<{ univariate: Record<string, LogisticUniResult & { error?: string }> }>),

  logisticMultivariate: (
    rows: Record<string, unknown>[],
    outcome: string,
    predictors: string[],
    variableOverrides: Record<string, unknown> = {},
    confidenceLevel = 0.95,
    signal?: AbortSignal,
  ) =>
    fetch("/api/analyze/logistic-multivariate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ rows, outcome, predictors, variable_overrides: variableOverrides, confidence_level: confidenceLevel }),
    }).then(parse<LogisticMultiResult>),

  saveProject: (payload: Record<string, unknown>) =>
    fetch("/api/project/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(parse<{ project_id: string; saved_at: string }>).then((r) => { return r; }),

  listProjects: () => fetch("/api/projects").then(parse<ProjectMeta[]>),

  loadProject: (projectId: string) =>
    fetch("/api/project/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    }).then(parse<SavedProject>),

  deleteProject: (projectId: string) =>
    fetch(`/api/project/${encodeURIComponent(projectId)}`, { method: "DELETE" }).then(parse<{ status: string }>),

  exportDocx: async (options: ExportOptions) => {
    const response = await fetch("/api/export/table-one.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildExportBody(options)),
    });
    if (!response.ok) throw new Error("Не удалось сформировать DOCX");
    return response.blob();
  },

  exportReport: async (
    tables: ExportOptions[],
    regression?: { analysis: RegressionAnalysis; cutoff: number; labels: Record<string, string> },
    correlation?: { result: unknown; include_matrix: boolean; pairs: unknown[] },
  ) => {
    const response = await fetch("/api/export/report.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tables: tables.map(buildExportBody), regression, correlation }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: `Ошибка сервера ${response.status}` }));
      throw new Error(err.detail || `Ошибка ${response.status}`);
    }
    return response.blob();
  },
};
