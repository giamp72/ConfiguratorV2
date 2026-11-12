import { chooseOption, findConfiguration, selectableOptions } from './conditions.mjs';

export function updateConditionSelects(container, selector, attributes, rules, previous, changedId = null, changedValue = null) {
  const preferred = previous || new Map(attributes.map((a) => [a.id, a.defaultId]));
  const selection = changedId == null
    ? findConfiguration(attributes, rules, new Map(), preferred)
    : chooseOption(attributes, rules, preferred, changedId, changedValue);
  if (!selection) return null;
  for (const select of container.querySelectorAll(selector)) {
    const id = Number(select.dataset.conditionAttribute);
    const available = new Set(selectableOptions(attributes, rules, selection, id).map((o) => String(o.id_opzione)));
    for (const option of select.options) option.hidden = option.disabled = !available.has(option.value);
    select.value = String(selection.get(id));
  }
  return selection;
}
