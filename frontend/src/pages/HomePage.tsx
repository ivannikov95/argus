import type { ProjectMeta } from "../api";

function ArgusMark({ className = "" }: { className?: string }) {
  return <img className={`argus-mark ${className}`.trim()} src="/argus-mark.svg" alt="" aria-hidden="true" />;
}

const CARD_GRADIENTS = [
  "linear-gradient(135deg,#0d47a1,#1565c0,#1976d2)",
  "linear-gradient(135deg,#1b5e20,#2e7d32,#43a047)",
  "linear-gradient(135deg,#4a148c,#6a1b9a,#8e24aa)",
  "linear-gradient(135deg,#b71c1c,#c62828,#e53935)",
  "linear-gradient(135deg,#e65100,#ef6c00,#fb8c00)",
  "linear-gradient(135deg,#004d40,#00695c,#00897b)",
];

const HV_ROWS = [
  ["Возраст, M ± SD", "63,5 ± 9,8", "62,4 ± 9,6", "64,7 ± 9,9", "0,203"],
  ["Пол (муж.), n (%)", "38 (63%)", "19 (63%)", "19 (63%)", "1,000"],
  ["ЦРБ, Me [Q1;Q3]", "4,2 [2,1;8,6]", "4,1 [2,0;8,4]", "4,3 [2,2;8,8]", "0,841"],
  ["ФВЛЖ, M ± SD", "52,3 ± 8,1", "53,1 ± 7,9", "51,4 ± 8,4", "0,047"],
];

export interface HomePageProps {
  savedProjects: ProjectMeta[];
  onImport: () => void;
  onDemo: () => void;
  onLoadProject: (id: string) => void;
  onDeleteProject: (id: string, name: string) => void;
  hasData: boolean;
  onContinue: () => void;
}

export function HomePage({ savedProjects, onImport, onDemo, onLoadProject, onDeleteProject, hasData, onContinue }: HomePageProps) {
  return (
    <section className="home-page">
      {/* Sticky top nav */}
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand">
            <ArgusMark className="argus-mark--header" />
            <div><strong>Argus</strong><small>Видеть больше в данных</small></div>
          </div>
          <div className="home-nav-actions">
            {hasData && <button className="home-nav-btn" onClick={onContinue}>Продолжить работу →</button>}
            <button className="home-nav-btn" onClick={onImport}>Импорт данных</button>
            <button className="home-nav-btn-primary" onClick={onDemo}>Демо-данные</button>
          </div>
        </div>
      </header>

      {/* Full-width hero */}
      <div className="home-hero">
        <div className="home-hero-inner">
          <div className="home-hero-content">
            <div className="home-hero-eyebrow"><ArgusMark className="argus-mark--hero" /> ARGUS · MEDICAL STATISTICS</div>
            <h1>Воспроизводимая<br/>медицинская<br/>статистика</h1>
            <p>Автоматический выбор критерия, Table 1 по стандартам публикаций, экспорт DOCX — без написания кода.</p>
            <div className="home-hero-btns">
              <button className="home-btn-primary" onClick={onImport}>Импорт CSV / XLSX</button>
              <button className="home-btn-secondary" onClick={onDemo}>Попробовать демо</button>
            </div>
            <div className="home-hero-stats">
              <div className="hstat"><span>t-Welch</span><small>/ Mann–Whitney</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>χ²</span><small>/ Fisher</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>Cohen's d</span><small>размер эффекта</small></div>
              <div className="hstat-div" />
              <div className="hstat"><span>DOCX</span><small>публикационный стиль</small></div>
            </div>
          </div>

          <div className="home-hero-visual" aria-hidden="true">
            <div className="hv-label">ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР</div>
            <div className="hv-card">
              <div className="hv-card-title">Таблица 1 — Клинические характеристики</div>
              <div className="hv-grid">
                {["Показатель","Все (n=60)","Группа А (n=30)","Группа Б (n=30)","p"].map((h,i) =>
                  <div key={h} className={`hv-th${i===0?" hv-th-first":""}`}>{h}</div>)}
                {HV_ROWS.map((row, ri) =>
                  row.map((cell, ci) => (
                    <div key={`${ri}-${ci}`} className={`hv-td${ci===0?" hv-td-first":""}${ci===4&&(ri===0||ri===3)?" hv-p-sig":""}`}>{cell}</div>
                  ))
                )}
              </div>
              <div className="hv-footer">
                <span>M ± SD — среднее ± стандартное отклонение; Me [Q1;Q3] — медиана с квартилями</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content sections */}
      <div className="home-inner">
        {savedProjects.length > 0 && (
          <div className="home-section">
            <div className="home-section-head">
              <h2>Последние проекты</h2>
              <span className="count-badge">{savedProjects.length}</span>
            </div>
            <div className="home-projects-grid">
              {savedProjects.map((p, i) => (
                <div key={p.project_id} className="project-card-wrap">
                  <button className="project-card" onClick={() => onLoadProject(p.project_id)}>
                    <div className="project-card-thumb" style={{ background: CARD_GRADIENTS[i % CARD_GRADIENTS.length] }}>
                      <span className="project-card-initial">{p.project_name.charAt(0).toUpperCase()}</span>
                    </div>
                    <div className="project-card-body">
                      <strong>{p.project_name}</strong>
                      <span>{p.file_name}</span>
                      <small>{new Date(p.saved_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</small>
                    </div>
                  </button>
                  <button
                    className="project-card-delete"
                    title="Удалить проект"
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p.project_id, p.project_name); }}
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="home-section">
          <div className="home-section-head"><h2>Возможности</h2></div>
          <div className="home-features">
            {[
              { icon: "▥", title: "Table 1 — автоматически", text: "Shapiro-Wilk → t-Welch или Mann–Whitney. χ² / Fisher для категорий. Cohen's d, Cramér's V, OR с 95% ДИ." },
              { icon: "⊞", title: "Многотабличный DOCX", text: "Несколько независимых таблиц с разными переменными — в один отчёт с разрывами страниц, Times New Roman." },
              { icon: "≡", title: "Словарь переменных", text: "Кастомные подписи, типы, роли переменных. Все решения прозрачны и остаются с проектом." },
              { icon: "⊙", title: "Локальная обработка", text: "Данные не покидают ваш компьютер. Никаких внешних API, облаков и третьих сторон." },
            ].map(({ icon, title, text }) => (
              <div key={title} className="feature-card">
                <div className="feature-icon">{icon}</div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default HomePage;
