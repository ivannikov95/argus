import type { VariableSchema } from "../types";

export interface VariablesPageProps {
  schema: VariableSchema[];
  onUpdate: (name: string, patch: Partial<VariableSchema>) => void;
  onContinue: () => void;
}

export function VariablesPage({ schema, onUpdate, onContinue }: VariablesPageProps) {
  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">02 · Словарь данных</span><h1>Переменные</h1><p>Подтвердите семантику: укажите правильный тип и роль каждой переменной перед анализом.</p></div><button className="button primary" onClick={onContinue}>Перейти к Table 1</button></div>
      <div className="panel variable-panel">
        <div className="variable-head variable-row"><span>Имя и подпись</span><span>Тип</span><span>Роль</span><span>Пропуски</span><span>Уникальных</span></div>
        {schema.map((item) => (
          <div className="variable-row" key={item.name}>
            <div><code>{item.name}</code><input value={item.label} onChange={(e) => onUpdate(item.name, { label: e.target.value })} aria-label={`Подпись ${item.name}`} /></div>
            <select value={item.type} onChange={(e) => onUpdate(item.name, { type: e.target.value as VariableSchema["type"] })}><option value="numeric">Числовая</option><option value="categorical">Категориальная</option><option value="binary">Бинарная</option><option value="text">Текст</option></select>
            <select value={item.role} onChange={(e) => onUpdate(item.name, { role: e.target.value as VariableSchema["role"] })}><option value="feature">Предиктор</option><option value="group">Группа</option><option value="outcome">Исход</option><option value="id">ID</option></select>
            <span className={item.missing ? "bad-value" : "muted-value"}>{item.missing} ({item.missing_percent}%)</span><span>{item.unique}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default VariablesPage;
