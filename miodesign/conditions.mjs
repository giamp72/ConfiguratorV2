export const comboKey = (pairs) => [...pairs].sort((a, b) => a[0] - b[0]).map(([a, o]) => `${a}:${o}`).join('|');

export function validateRules(attributes, rules) {
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const keys = new Set();
  for (const rule of rules) {
    const source = byId.get(rule.source);
    const target = byId.get(rule.target);
    if (!source || !target || source.id === target.id) throw new Error('Ogni condizione deve collegare due attributi diversi del prodotto.');
    if (!source.options.some((o) => o.id_opzione === rule.when)) throw new Error('La condizione usa un’opzione di partenza non più ammessa.');
    if (!rule.allowed.length || rule.allowed.some((id) => !target.options.some((o) => o.id_opzione === id))) {
      throw new Error('Seleziona almeno un’opzione di destinazione ammessa per ogni condizione.');
    }
    const key = `${rule.source}:${rule.when}:${rule.target}`;
    if (keys.has(key)) throw new Error('Esiste già una condizione per questo attributo, valore e destinazione.');
    keys.add(key);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('Le condizioni non possono formare un ciclo tra attributi.');
    if (visited.has(id)) return;
    visiting.add(id);
    rules.filter((r) => r.source === id).forEach((r) => visit(r.target));
    visiting.delete(id);
    visited.add(id);
  };
  attributes.forEach((a) => visit(a.id));
}

function compatible(selection, rules) {
  return rules.every((rule) => !selection.has(rule.source) || selection.get(rule.source) !== rule.when
    || !selection.has(rule.target) || rule.allowed.includes(selection.get(rule.target)));
}

export function findConfiguration(attributes, rules, fixed = new Map(), preferred = new Map()) {
  const byId = new Map(attributes.map((a) => [a.id, a]));
  for (const [id, value] of fixed) {
    if (!byId.get(id)?.options.some((o) => o.id_opzione === value)) return null;
  }
  const selection = new Map(fixed);
  if (!compatible(selection, rules)) return null;
  const remaining = [];
  const visited = new Set(fixed.keys());
  const visitParents = (attribute) => {
    if (visited.has(attribute.id)) return;
    visited.add(attribute.id);
    rules.filter((r) => r.target === attribute.id).forEach((rule) => {
      const parent = byId.get(rule.source);
      if (parent) visitParents(parent);
    });
    remaining.push(attribute);
  };
  attributes.forEach(visitParents);
  const visit = (index) => {
    if (index === remaining.length) return new Map(selection);
    const attribute = remaining[index];
    const options = attribute.options.map((o) => o.id_opzione);
    const preferredId = preferred.get(attribute.id);
    if (options.includes(preferredId)) options.unshift(...options.splice(options.indexOf(preferredId), 1));
    for (const option of options) {
      selection.set(attribute.id, option);
      if (compatible(selection, rules)) {
        const found = visit(index + 1);
        if (found) return found;
      }
    }
    selection.delete(attribute.id);
    return null;
  };
  return visit(0);
}

export function ancestors(id, rules) {
  const result = new Set();
  const visit = (target) => rules.filter((r) => r.target === target).forEach((r) => {
    if (!result.has(r.source)) { result.add(r.source); visit(r.source); }
  });
  visit(id);
  return result;
}

export function selectableOptions(attributes, rules, selection, id) {
  const fixedIds = ancestors(id, rules);
  const fixed = new Map([...selection].filter(([key]) => fixedIds.has(key)));
  const attribute = attributes.find((a) => a.id === id);
  return attribute.options.filter((option) => findConfiguration(attributes, rules,
    new Map([...fixed, [id, option.id_opzione]]), selection));
}

export function chooseOption(attributes, rules, selection, id, value) {
  const fixedIds = ancestors(id, rules);
  const fixed = new Map([...selection].filter(([key]) => fixedIds.has(key)));
  fixed.set(id, value);
  return findConfiguration(attributes, rules, fixed, selection);
}

export function codingCombinations(attributes, rules, limit) {
  const coding = attributes.filter((a) => a.codifica);
  const results = [];
  const pairs = [];
  const visit = (index) => {
    if (results.length > limit) return;
    if (index === coding.length) {
      if (findConfiguration(attributes, rules, new Map(pairs))) results.push([...pairs]);
      return;
    }
    const attribute = coding[index];
    for (const option of attribute.options) {
      pairs.push([attribute.id, option.id_opzione]);
      if (compatible(new Map(pairs), rules)) visit(index + 1);
      pairs.pop();
      if (results.length > limit) break;
    }
  };
  visit(0);
  return results;
}

export function rulesFromRows(rows, values) {
  const key = (row) => `${row.id_attributo_origine}:${row.id_opzione_origine}:${row.id_attributo_destinazione}`;
  const grouped = new Map(rows.map((row) => [key(row), {
    source: row.id_attributo_origine, when: row.id_opzione_origine,
    target: row.id_attributo_destinazione, allowed: [],
  }]));
  values.forEach((row) => grouped.get(key(row))?.allowed.push(row.id_opzione_destinazione));
  return [...grouped.values()];
}

export function rulesToRows(rules) {
  return rules.map((rule) => ({
    id_attributo_origine: rule.source, id_opzione_origine: rule.when,
    id_attributo_destinazione: rule.target, valori: rule.allowed,
  }));
}
