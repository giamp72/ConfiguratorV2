import { validateRules } from './conditions.mjs';

export function createConditionEditor(container, initialRules, getAttributes, escape, onChange = () => {}) {
  const rules = initialRules.map((rule) => ({ ...rule, allowed: [...rule.allowed] }));
  const label = (item) => item.descrizione ? `${item.nome} — ${item.descrizione}` : item.nome;
  const option = (value, text, selected) => `<option value="${value}" ${selected ? 'selected' : ''}>${escape(text)}</option>`;
  const draw = () => {
    const attributes = getAttributes();
    container.innerHTML = rules.map((rule, index) => {
      const source = attributes.find((a) => a.id === rule.source);
      const target = attributes.find((a) => a.id === rule.target);
      const attrOptions = (selected, exclude) => '<option value="">— seleziona —</option>'
        + attributes.filter((a) => a.id !== exclude).map((a) => option(a.id, label(a), a.id === selected)).join('');
      const unknown = rule.allowed.filter((id) => !target?.options.some((o) => o.id_opzione === id));
      return `<div class="condition-rule" data-rule="${index}">
        <div class="row"><div><label>Se l'attributo</label><select data-rule-field="source" aria-label="Attributo di partenza">${attrOptions(rule.source, rule.target)}</select></div>
        <div><label>ha il valore</label><select data-rule-field="when" aria-label="Valore di partenza"><option value="">— seleziona —</option>${(source?.options || []).map((o) => option(o.id_opzione, label(o), o.id_opzione === rule.when)).join('')}</select></div>
        <div><label>allora l'attributo</label><select data-rule-field="target" aria-label="Attributo di destinazione">${attrOptions(rule.target, rule.source)}</select></div>
        <div class="shrink"><button type="button" class="small danger" data-rule-remove>Rimuovi</button></div></div>
        <label>può assumere solo questi valori</label>
        <div class="opt-grid">${(target?.options || []).map((o) => `<label class="check"><input type="checkbox" data-rule-option="${o.id_opzione}" ${rule.allowed.includes(o.id_opzione) ? 'checked' : ''}> ${escape(label(o))}</label>`).join('') || '<span class="muted">Seleziona un attributo con opzioni ammesse.</span>'}</div>
        ${unknown.length || (rule.when && !source?.options.some((o) => o.id_opzione === rule.when)) || (rule.source && !source) || (rule.target && !target) ? '<p class="error-text">La condizione contiene attributi o opzioni non più ammessi: correggila o rimuovila.</p>' : ''}
      </div>`;
    }).join('') || '<p class="muted">Nessuna condizione definita.</p>';
  };
  container.addEventListener('change', (event) => {
    const row = event.target.closest('[data-rule]');
    if (!row) return;
    const rule = rules[Number(row.dataset.rule)];
    if (event.target.dataset.ruleOption) {
      const id = Number(event.target.dataset.ruleOption);
      rule.allowed = event.target.checked ? [...rule.allowed, id] : rule.allowed.filter((value) => value !== id);
    } else {
      const field = event.target.dataset.ruleField;
      if (!field) return;
      rule[field] = event.target.value ? Number(event.target.value) : null;
      if (field === 'source') rule.when = null;
      if (field === 'target') rule.allowed = [];
    }
    draw();
    onChange();
  });
  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rule-remove]');
    if (!button) return;
    rules.splice(Number(button.closest('[data-rule]').dataset.rule), 1);
    draw();
    onChange();
  });
  return {
    add() { rules.push({ source: null, when: null, target: null, allowed: [] }); draw(); onChange(); },
    refresh: draw,
    getRules() { validateRules(getAttributes(), rules); return rules.map((r) => ({ ...r, allowed: [...r.allowed] })); },
  };
}
