from __future__ import annotations

import io
import json
import math
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.section import WD_ORIENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from scipy import stats


ROOT = Path(__file__).resolve().parents[1]
PROJECTS_DIR = ROOT / "data" / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="MedStat Studio API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TableOneRequest(BaseModel):
    rows: list[dict[str, Any]]
    group_column: str | None = None
    variables: list[str] | None = None
    numeric_presentation: str = "auto"
    numeric_test: str = "auto"
    categorical_test: str = "auto"
    confidence_level: float = Field(default=0.95, gt=0.5, lt=1.0)


class ProjectSaveRequest(BaseModel):
    project_id: str | None = None  # if set → overwrite existing file
    project_name: str = Field(min_length=1, max_length=120)
    file_name: str = "dataset"
    rows: list[dict[str, Any]]
    variable_overrides: dict[str, dict[str, Any]] = {}
    last_analysis: dict[str, Any] | None = None
    table_settings: dict[str, Any] = {}


class ExportRequest(BaseModel):
    title: str = "Таблица 1 - Характеристики выборки"
    description: str = ""
    footnotes: str = ""
    show_overall: bool = True
    show_effect: bool = True
    show_ci: bool = True
    show_missing: bool = True
    decompose_categories: bool = False
    analysis: dict[str, Any]


class DatasetProfileRequest(BaseModel):
    rows: list[dict[str, Any]]
    file_name: str = "Загруженный датасет"


class ReportExportRequest(BaseModel):
    tables: list[ExportRequest]


def clean_scalar(value: Any) -> Any:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    return value


def frame_to_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {str(key): clean_scalar(value) for key, value in row.items()}
        for row in df.to_dict(orient="records")
    ]


def to_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        raise HTTPException(422, "Датасет пуст")
    return pd.DataFrame(rows)


def infer_column(series: pd.Series) -> dict[str, Any]:
    non_null = series.dropna()
    unique = int(non_null.nunique(dropna=True))
    numeric = pd.to_numeric(non_null, errors="coerce")
    numeric_share = float(numeric.notna().mean()) if len(non_null) else 0.0
    if unique == 2:
        kind = "binary"
    elif numeric_share >= 0.9 and unique > 2:
        kind = "numeric"
    elif unique <= max(20, int(math.sqrt(max(len(series), 1))) + 2):
        kind = "categorical"
    else:
        kind = "text"
    examples = [clean_scalar(v) for v in non_null.unique()[:3]]
    return {
        "name": str(series.name),
        "label": str(series.name).replace("_", " ").strip().title(),
        "type": kind,
        "role": "id" if str(series.name).lower() in {"id", "patient_id", "subject_id"} else "feature",
        "count": int(non_null.size),
        "missing": int(series.isna().sum()),
        "missing_percent": round(float(series.isna().mean() * 100), 1),
        "unique": unique,
        "examples": examples,
    }


def dataset_profile(df: pd.DataFrame) -> dict[str, Any]:
    schema = [infer_column(df[column]) for column in df.columns]
    return {
        "row_count": int(len(df)),
        "column_count": int(len(df.columns)),
        "missing_count": int(df.isna().sum().sum()),
        "duplicate_count": int(df.duplicated().sum()),
        "schema": schema,
        "rows": frame_to_rows(df),
    }


def demo_frame() -> pd.DataFrame:
    rng = np.random.default_rng(20250628)
    n = 120
    group = np.where(np.arange(n) % 2 == 0, "Контроль", "Терапия")
    age = np.clip(rng.normal(62 + (group == "Терапия") * 1.8, 10, n), 31, 86).round()
    bmi = rng.normal(27.5 - (group == "Терапия") * 0.4, 4.1, n).round(1)
    crp = np.exp(rng.normal(1.05 - (group == "Терапия") * 0.2, 0.8, n)).round(1)
    lvef = np.clip(rng.normal(52 + (group == "Терапия") * 2.2, 7, n), 25, 72).round()
    sex = rng.choice(["Женский", "Мужской"], n, p=[0.44, 0.56])
    hypertension = np.where(rng.random(n) < (0.35 + age / 250), "Да", "Нет")
    event = np.where(rng.random(n) < (0.23 - (group == "Терапия") * 0.06), "Да", "Нет")
    df = pd.DataFrame({
        "patient_id": [f"P-{i:03d}" for i in range(1, n + 1)],
        "group": group,
        "age": age,
        "sex": sex,
        "bmi": bmi,
        "crp": crp,
        "lvef": lvef,
        "hypertension": hypertension,
        "event_30d": event,
    })
    df.loc[[7, 41, 88], "crp"] = np.nan
    df.loc[[15, 70], "bmi"] = np.nan
    return df


def welch_anova(groups: list[pd.Series]) -> tuple[float, float]:
    k = len(groups)
    ns = np.array([len(g) for g in groups], dtype=float)
    means = np.array([float(g.mean()) for g in groups])
    vars_ = np.array([float(g.var(ddof=1)) for g in groups])
    if np.any(ns < 2) or np.any(vars_ == 0):
        f_stat, p_value = stats.f_oneway(*groups)
        return float(f_stat), float(p_value)
    ws = ns / vars_
    W = ws.sum()
    grand = (ws * means).sum() / W
    tmp = ((1 - ws / W) ** 2 / (ns - 1)).sum()
    F = (ws * (means - grand) ** 2).sum() / ((k - 1) * (1 + 2 * (k - 2) / (k ** 2 - 1) * tmp))
    df2 = (k ** 2 - 1) / (3 * tmp)
    return float(F), float(stats.f.sf(F, k - 1, df2))


def normal_enough(values: pd.Series) -> bool:
    values = values.dropna().astype(float)
    if len(values) < 8:
        return False
    if len(values) > 5000:
        values = values.sample(5000, random_state=42)
    try:
        return bool(stats.shapiro(values).pvalue >= 0.05)
    except ValueError:
        return False


def fmt_number(value: float, digits: int = 1) -> str:
    if not np.isfinite(value):
        return "—"
    return f"{value:.{digits}f}".replace(".", ",")


def numeric_summary(values: pd.Series, use_mean: bool) -> str:
    values = pd.to_numeric(values, errors="coerce").dropna()
    if values.empty:
        return "—"
    if use_mean:
        return f"{fmt_number(values.mean())} ± {fmt_number(values.std(ddof=1))}"
    q1, median, q3 = values.quantile([0.25, 0.5, 0.75])
    return f"{fmt_number(median)} [{fmt_number(q1)}; {fmt_number(q3)}]"


def categorical_summary(values: pd.Series) -> str:
    clean = values.dropna().astype(str)
    if clean.empty:
        return "—"
    counts = clean.value_counts()
    return "; ".join(
        f"{level}: {count} ({count / len(clean) * 100:.1f}%)"
        for level, count in counts.items()
    )


def p_text(value: float | None) -> str:
    if value is None or not np.isfinite(value):
        return "—"
    return "<0,001" if value < 0.001 else f"{value:.3f}".replace(".", ",")


def mean_difference_ci(first: pd.Series, second: pd.Series, confidence: float) -> tuple[float, float, float] | None:
    if len(first) < 2 or len(second) < 2:
        return None
    estimate = float(second.mean() - first.mean())
    variance_first = float(first.var(ddof=1) / len(first))
    variance_second = float(second.var(ddof=1) / len(second))
    standard_error = math.sqrt(variance_first + variance_second)
    if not standard_error:
        return estimate, estimate, estimate
    denominator = (variance_first**2 / (len(first) - 1)) + (variance_second**2 / (len(second) - 1))
    degrees_freedom = (variance_first + variance_second) ** 2 / denominator if denominator else len(first) + len(second) - 2
    critical = float(stats.t.ppf((1 + confidence) / 2, degrees_freedom))
    return estimate, estimate - critical * standard_error, estimate + critical * standard_error


def median_difference_ci(first: pd.Series, second: pd.Series, confidence: float) -> tuple[float, float, float] | None:
    if len(first) < 2 or len(second) < 2:
        return None
    first_values = first.to_numpy(dtype=float)
    second_values = second.to_numpy(dtype=float)
    rng = np.random.default_rng(20250628)
    if len(first_values) > 5000:
        first_values = rng.choice(first_values, 5000, replace=False)
    if len(second_values) > 5000:
        second_values = rng.choice(second_values, 5000, replace=False)
    estimate = float(np.median(second_values) - np.median(first_values))
    bootstrap = np.empty(1000)
    for index in range(len(bootstrap)):
        bootstrap[index] = np.median(rng.choice(second_values, len(second_values), replace=True)) - np.median(rng.choice(first_values, len(first_values), replace=True))
    alpha = (1 - confidence) / 2
    lower, upper = np.quantile(bootstrap, [alpha, 1 - alpha])
    return estimate, float(lower), float(upper)


def odds_ratio_ci(table: pd.DataFrame, confidence: float) -> tuple[float, float, float, str] | None:
    if table.shape != (2, 2):
        return None
    values = table.to_numpy(dtype=float)
    event_control, event_treatment = values[1, 0], values[1, 1]
    no_event_control, no_event_treatment = values[0, 0], values[0, 1]
    if (values == 0).any():
        event_control += 0.5
        event_treatment += 0.5
        no_event_control += 0.5
        no_event_treatment += 0.5
    odds_ratio = (event_treatment * no_event_control) / (no_event_treatment * event_control)
    standard_error = math.sqrt(1 / event_treatment + 1 / no_event_treatment + 1 / event_control + 1 / no_event_control)
    critical = float(stats.norm.ppf((1 + confidence) / 2))
    lower = math.exp(math.log(odds_ratio) - critical * standard_error)
    upper = math.exp(math.log(odds_ratio) + critical * standard_error)
    return float(odds_ratio), float(lower), float(upper), str(table.index[1])


def level_summaries(series: pd.Series, grouped: list[pd.Series], groups: list[str]) -> list[dict[str, Any]]:
    levels = [str(value) for value in series.dropna().astype(str).unique()]
    levels = sorted(levels)
    result = []
    for level in levels:
        clean = series.dropna().astype(str)
        overall_count = int((clean == level).sum())
        group_values: dict[str, str] = {}
        for group_name, values in zip(groups, grouped):
            group_clean = values.dropna().astype(str)
            count = int((group_clean == level).sum())
            group_values[group_name] = f"{count} ({count / len(group_clean) * 100:.1f}%)" if len(group_clean) else "—"
        result.append({
            "level": level,
            "overall": f"{overall_count} ({overall_count / len(clean) * 100:.1f}%)" if len(clean) else "—",
            "groups": group_values,
        })
    return result


def analyze_numeric(df: pd.DataFrame, variable: str, group: str | None, groups: list[str], request: TableOneRequest) -> dict[str, Any]:
    series = pd.to_numeric(df[variable], errors="coerce")
    grouped = [pd.to_numeric(df.loc[df[group].astype(str) == g, variable], errors="coerce").dropna() for g in groups] if group else []
    automatic_mean = normal_enough(series) and all(normal_enough(part) for part in grouped)
    use_mean = automatic_mean if request.numeric_presentation == "auto" else request.numeric_presentation == "mean_sd"
    parametric_test = use_mean if request.numeric_test == "auto" else request.numeric_test == "parametric"
    test_name, p_value, effect, ci = "—", None, None, None
    ci_label = "—"
    if len(grouped) == 2 and all(len(part) >= 2 for part in grouped):
        if parametric_test:
            result = stats.ttest_ind(grouped[0], grouped[1], equal_var=False, nan_policy="omit")
            test_name, p_value = "t-критерий Уэлча", float(result.pvalue)
            ci = mean_difference_ci(grouped[0], grouped[1], request.confidence_level)
            ci_label = "Разность средних"
        else:
            result = stats.mannwhitneyu(grouped[0], grouped[1], alternative="two-sided")
            test_name, p_value = "U-критерий Манна–Уитни", float(result.pvalue)
            ci = median_difference_ci(grouped[0], grouped[1], request.confidence_level)
            ci_label = "Разность медиан (bootstrap)"
        pooled = math.sqrt((grouped[0].var(ddof=1) + grouped[1].var(ddof=1)) / 2)
        effect = float((grouped[1].mean() - grouped[0].mean()) / pooled) if pooled else None
    elif len(grouped) > 2 and all(len(part) >= 2 for part in grouped):
        if parametric_test:
            _, p_value = welch_anova(grouped)
            test_name = "ANOVA Уэлча"
        else:
            result = stats.kruskal(*grouped)
            test_name, p_value = "Краскела–Уоллиса", float(result.pvalue)
    confidence_percent = round(request.confidence_level * 100)
    return {
        "variable": variable,
        "type": "numeric",
        "presentation": "Среднее ± SD" if use_mean else "Медиана [Q1; Q3]",
        "overall": numeric_summary(series, use_mean),
        "groups": {g: numeric_summary(part, use_mean) for g, part in zip(groups, grouped)},
        "missing": int(series.isna().sum()),
        "test": test_name,
        "p_value": p_value,
        "p_display": p_text(p_value),
        "effect": fmt_number(effect, 2) if effect is not None else "—",
        "effect_label": "SMD" if effect is not None else "—",
        "ci_display": f"{fmt_number(ci[0], 2)} [{fmt_number(ci[1], 2)}; {fmt_number(ci[2], 2)}]" if ci else "—",
        "ci_label": f"{ci_label}, {confidence_percent}% ДИ" if ci else "—",
        "normality": "Распределение совместимо с нормальным" if automatic_mean else "Есть отклонение от нормального распределения",
        "levels": [],
    }


def analyze_categorical(df: pd.DataFrame, variable: str, group: str | None, groups: list[str], request: TableOneRequest) -> dict[str, Any]:
    series = df[variable]
    grouped = [df.loc[df[group].astype(str) == g, variable] for g in groups] if group else []
    test_name, p_value, effect, ci = "—", None, None, None
    ci_label = "—"
    if group and len(groups) >= 2:
        table = pd.crosstab(df[variable], df[group])
        if table.shape[0] >= 2 and table.shape[1] >= 2:
            chi2, chi_p, _, expected = stats.chi2_contingency(table)
            force_fisher = request.categorical_test == "fisher" and table.shape == (2, 2)
            force_chi = request.categorical_test == "chi_square"
            if table.shape == (2, 2) and ((expected < 5).any() or force_fisher) and not force_chi:
                _, fisher_p = stats.fisher_exact(table)
                test_name, p_value = "Точный критерий Фишера", float(fisher_p)
            else:
                test_name, p_value = "χ² Пирсона", float(chi_p)
            denom = min(table.shape[0] - 1, table.shape[1] - 1)
            effect = math.sqrt(chi2 / (table.to_numpy().sum() * denom)) if denom else None
            ci = odds_ratio_ci(table, request.confidence_level)
            if ci:
                ci_label = f"ОШ для уровня «{ci[3]}», {round(request.confidence_level * 100)}% ДИ"
    return {
        "variable": variable,
        "type": "categorical",
        "presentation": "n (%)",
        "overall": categorical_summary(series),
        "groups": {g: categorical_summary(part) for g, part in zip(groups, grouped)},
        "missing": int(series.isna().sum()),
        "test": test_name,
        "p_value": p_value,
        "p_display": p_text(p_value),
        "effect": fmt_number(effect, 2) if effect is not None else "—",
        "effect_label": "V Крамера" if effect is not None else "—",
        "ci_display": f"{fmt_number(ci[0], 2)} [{fmt_number(ci[1], 2)}; {fmt_number(ci[2], 2)}]" if ci else "—",
        "ci_label": ci_label,
        "normality": "—",
        "levels": level_summaries(series, grouped, groups),
    }


def run_table_one(request: TableOneRequest) -> dict[str, Any]:
    df = to_frame(request.rows)
    if request.group_column and request.group_column not in df.columns:
        raise HTTPException(422, "Группирующая переменная отсутствует в датасете")
    groups = []
    if request.group_column:
        groups = [str(value) for value in df[request.group_column].dropna().unique()]
        groups = sorted(groups)[:8]
    variables = request.variables or list(df.columns)
    variables = [v for v in variables if v in df.columns and v != request.group_column]
    schema = {item["name"]: item for item in (infer_column(df[col]) for col in df.columns)}
    result_rows = []
    for variable in variables:
        kind = schema[variable]["type"]
        if schema[variable]["role"] == "id" or kind == "text":
            continue
        if kind == "numeric":
            result_rows.append(analyze_numeric(df, variable, request.group_column, groups, request))
        else:
            result_rows.append(analyze_categorical(df, variable, request.group_column, groups, request))
    automatic_mode = request.numeric_presentation == "auto" and request.numeric_test == "auto" and request.categorical_test == "auto"
    method_note = (
        "Представление и критерии выбраны автоматически по типу и распределению данных."
        if automatic_mode
        else "Часть представлений или критериев задана исследователем вручную."
    )
    return {
        "n": int(len(df)),
        "group_column": request.group_column,
        "groups": [{"name": g, "n": int((df[request.group_column].astype(str) == g).sum())} for g in groups] if request.group_column else [],
        "rows": result_rows,
        "note": f"{method_note} Перед публикацией метод должен быть подтверждён исследователем.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.get("/api/demo-data")
def demo_data() -> dict[str, Any]:
    return {"file_name": "Демонстрационный набор данных", **dataset_profile(demo_frame())}


@app.post("/api/dataset/import")
async def import_dataset(file: UploadFile = File(...)) -> dict[str, Any]:
    suffix = Path(file.filename or "").suffix.lower()
    content = await file.read()
    try:
        if suffix == ".csv":
            try:
                df = pd.read_csv(io.BytesIO(content), sep=None, engine="python")
            except UnicodeDecodeError:
                df = pd.read_csv(io.BytesIO(content), encoding="cp1251", sep=None, engine="python")
        elif suffix in {".xlsx", ".xlsm"}:
            df = pd.read_excel(io.BytesIO(content))
        else:
            raise HTTPException(415, "Поддерживаются CSV и XLSX")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Не удалось прочитать файл: {exc}") from exc
    if len(df) > 100_000 or len(df.columns) > 500:
        raise HTTPException(413, "Для MVP лимит: 100 000 строк и 500 столбцов")
    return {"file_name": file.filename, **dataset_profile(df)}


@app.post("/api/analyze/table-one")
def table_one(request: TableOneRequest) -> dict[str, Any]:
    return run_table_one(request)


@app.post("/api/project/save")
def save_project(request: ProjectSaveRequest) -> dict[str, Any]:
    if request.project_id:
        # overwrite — validate id is safe
        if not re.fullmatch(r"[a-zA-Zа-яА-Я0-9_-]+", request.project_id):
            raise HTTPException(400, "Некорректный project_id")
        project_id = request.project_id
    else:
        slug = re.sub(r"[^a-zA-Zа-яА-Я0-9_-]+", "-", request.project_name).strip("-").lower() or "project"
        project_id = f"{slug[:50]}-{uuid.uuid4().hex[:8]}"
    payload = request.model_dump(exclude={"project_id"})
    payload.update({"project_id": project_id, "saved_at": datetime.now(timezone.utc).isoformat()})
    (PROJECTS_DIR / f"{project_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"project_id": project_id, "saved_at": payload["saved_at"]}


@app.get("/api/projects")
def list_projects() -> list[dict[str, Any]]:
    projects = []
    for path in sorted(PROJECTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            projects.append({key: payload.get(key) for key in ("project_id", "project_name", "file_name", "saved_at")})
        except (OSError, json.JSONDecodeError):
            continue
    return projects


@app.post("/api/project/load")
def load_project(payload: dict[str, str]) -> dict[str, Any]:
    project_id = payload.get("project_id", "")
    if not re.fullmatch(r"[a-zA-Zа-яА-Я0-9_-]+", project_id):
        raise HTTPException(400, "Некорректный идентификатор проекта")
    path = PROJECTS_DIR / f"{project_id}.json"
    if not path.exists():
        raise HTTPException(404, "Проект не найден")
    return json.loads(path.read_text(encoding="utf-8"))


def _apply_tnr(run: Any, size: float, bold: bool | None = None) -> None:
    run.font.name = "Times New Roman"
    run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{attr}"), "Times New Roman")


def _normalize_caption(value: str) -> str:
    value = value.strip()
    if not value:
        return "Таблица 1 - Без названия"
    if re.match(r"^Таблица\s+\d+\s*[-–—]", value, flags=re.IGNORECASE):
        return re.sub(r"^(Таблица\s+\d+)\s*[-–—]\s*", r"\1 - ", value, flags=re.IGNORECASE)
    return f"Таблица 1 - {value}"


def _setup_document(document: Document) -> None:
    for section in document.sections:
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = Mm(210)
        section.page_height = Mm(297)
        section.left_margin = Mm(20)
        section.right_margin = Mm(20)
        section.top_margin = Mm(20)
        section.bottom_margin = Mm(20)
    normal_style = document.styles["Normal"]
    normal_style.font.name = "Times New Roman"
    normal_style.font.size = Pt(11)
    rpr = normal_style._element.get_or_add_rPr()
    fonts = rpr.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{attr}"), "Times New Roman")


def _append_table_block(document: Document, request: ExportRequest) -> None:
    analysis = request.analysis
    groups = analysis.get("groups", [])
    caption = document.add_paragraph()
    caption.paragraph_format.space_after = Pt(5)
    caption.paragraph_format.keep_with_next = True
    _apply_tnr(caption.add_run(_normalize_caption(request.title)), 14, False)
    if request.description:
        desc_p = document.add_paragraph()
        desc_p.paragraph_format.space_after = Pt(5)
        _apply_tnr(desc_p.add_run(request.description), 11, False)
    headers = ["Показатель"]
    if request.show_overall:
        headers.append(f"Все (n={analysis.get('n', '—')})")
    headers.extend(f"{g['name']} (n={g['n']})" for g in groups)
    if request.show_missing:
        headers.append("Пропуски")
    if request.show_ci:
        headers.append("95% ДИ")
    headers.append("p-value")
    if request.show_effect:
        headers.append("Размер эффекта")
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    for cell, value in zip(table.rows[0].cells, headers):
        cell.text = str(value)
    for item in analysis.get("rows", []):
        has_levels = bool(item.get("levels"))
        cells = table.add_row().cells
        _PRES_SHORT = {"Среднее ± SD": "M ± SD", "Медиана [Q1; Q3]": "Me [Q1; Q3]"}
        row_label = item.get("label") or item.get("variable", "")
        pres = _PRES_SHORT.get(item.get("presentation", ""), item.get("presentation", ""))
        values = [f"{row_label}, {pres}" if pres else row_label]
        if request.show_overall:
            values.append("" if has_levels else item["overall"])
        values.extend("" if has_levels else item.get("groups", {}).get(g["name"], "—") for g in groups)
        if request.show_missing:
            values.append(str(item.get("missing", 0)))
        if request.show_ci:
            values.append(item.get("ci_display", "—"))
        values.append(item.get("p_display", "—"))
        if request.show_effect:
            values.append(f"{item.get('effect_label', '')}: {item.get('effect', '—')}")
        for cell, value in zip(cells, values):
            cell.text = str(value)
        if has_levels:
            for level in item.get("levels", []):
                level_cells = table.add_row().cells
                level_values = [f"   {level.get('level', '—')}"]
                if request.show_overall:
                    level_values.append(level.get("overall", "—"))
                level_values.extend(level.get("groups", {}).get(g["name"], "—") for g in groups)
                if request.show_missing:
                    level_values.append("")
                if request.show_ci:
                    level_values.append("")
                level_values.append("")
                if request.show_effect:
                    level_values.append("")
                for cell, value in zip(level_cells, level_values):
                    cell.text = str(value)
    for row_index, row in enumerate(table.rows):
        for column_index, cell in enumerate(row.cells):
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for paragraph in cell.paragraphs:
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT if column_index == 0 and row_index > 0 else WD_ALIGN_PARAGRAPH.CENTER
                paragraph.paragraph_format.space_before = Pt(0)
                paragraph.paragraph_format.space_after = Pt(0)
                paragraph.paragraph_format.line_spacing = 1.0
                for run in paragraph.runs:
                    _apply_tnr(run, 11 if row_index > 0 else 12, row_index == 0)
    note = document.add_paragraph()
    note.paragraph_format.space_before = Pt(6)
    note.paragraph_format.space_after = Pt(0)
    _apply_tnr(note.add_run(analysis.get("note", "")), 10, False)
    if request.footnotes:
        footnotes_p = document.add_paragraph()
        footnotes_p.paragraph_format.space_before = Pt(3)
        _apply_tnr(footnotes_p.add_run(request.footnotes), 10, False)


def _stream_document(document: Document, filename: str) -> StreamingResponse:
    buffer = io.BytesIO()
    document.save(buffer)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/dataset/profile")
def compute_profile(request: DatasetProfileRequest) -> dict[str, Any]:
    df = to_frame(request.rows)
    return {"file_name": request.file_name, **dataset_profile(df)}


@app.post("/api/export/table-one.docx")
def export_docx(request: ExportRequest) -> StreamingResponse:
    document = Document()
    _setup_document(document)
    _append_table_block(document, request)
    return _stream_document(document, "table-one.docx")


@app.post("/api/export/report.docx")
def export_report(request: ReportExportRequest) -> StreamingResponse:
    if not request.tables:
        raise HTTPException(422, "Отчёт не содержит таблиц")
    document = Document()
    _setup_document(document)
    for index, table_request in enumerate(request.tables):
        if index > 0:
            document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        _append_table_block(document, table_request)
    return _stream_document(document, "report.docx")
