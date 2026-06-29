import type { Dataset, TableOneAnalysis } from "./types";

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
  ) =>
    fetch("/api/analyze/table-one", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows,
        group_column: groupColumn,
        variables,
        numeric_presentation: options.numericPresentation,
        numeric_test: options.numericTest,
        categorical_test: options.categoricalTest,
        confidence_level: options.confidenceLevel,
      }),
    }).then(parse<TableOneAnalysis>),

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
    fetch(`/api/project/${projectId}`, { method: "DELETE" }).then(parse<{ status: string }>),

  exportDocx: async (options: ExportOptions) => {
    const response = await fetch("/api/export/table-one.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildExportBody(options)),
    });
    if (!response.ok) throw new Error("Не удалось сформировать DOCX");
    return response.blob();
  },

  exportReport: async (tables: ExportOptions[]) => {
    const response = await fetch("/api/export/report.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tables: tables.map(buildExportBody) }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: `Ошибка сервера ${response.status}` }));
      throw new Error(err.detail || `Ошибка ${response.status}`);
    }
    return response.blob();
  },
};
