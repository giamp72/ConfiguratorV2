import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseOption, codingCombinations, comboKey, findConfiguration, rulesFromRows, rulesToRows, selectableOptions, validateRules,
} from '../conditions.mjs';

const attr = (id, values, codifica = true) => ({
  id, codifica, options: values.map((value) => ({ id_opzione: value })),
});
const attributes = [attr(1, [11, 12]), attr(2, [21, 22, 23]), attr(3, [31, 32], false)];
const rules = [
  { source: 1, when: 11, target: 2, allowed: [21, 22] },
  { source: 3, when: 31, target: 2, allowed: [22, 23] },
];

test('regole assenti e intersezione delle condizioni attive', () => {
  validateRules(attributes, rules);
  assert.equal(findConfiguration(attributes, rules, new Map([[1, 11], [3, 31], [2, 21]])), null);
  assert.ok(findConfiguration(attributes, rules, new Map([[1, 11], [3, 31], [2, 22]])));
  assert.ok(findConfiguration(attributes, rules, new Map([[1, 12], [3, 32], [2, 23]])));
});

test('vincoli e cicli non validi sono rifiutati', () => {
  assert.throws(() => validateRules(attributes, [{ ...rules[0], allowed: [] }]), /almeno/);
  assert.throws(() => validateRules(attributes, [rules[0], rules[0]]), /già/);
  assert.throws(() => validateRules(attributes, [rules[0], { source: 2, when: 21, target: 1, allowed: [11] }]), /ciclo/);
  assert.throws(() => validateRules(attributes, [{ ...rules[0], when: 99 }]), /partenza/);
  assert.throws(() => validateRules(attributes, [{ ...rules[0], allowed: [99] }]), /destinazione/);
});

test('selezione condizionata mantiene gli antenati e aggiorna le dipendenze', () => {
  const selected = new Map([[1, 12], [2, 23], [3, 31]]);
  const changed = chooseOption(attributes, rules, selected, 1, 11);
  assert.equal(changed.get(1), 11);
  assert.equal(changed.get(2), 22);
  assert.deepEqual(selectableOptions(attributes, rules, changed, 2).map((o) => o.id_opzione), [22]);
  assert.equal(chooseOption(attributes, rules, changed, 2, 21), null);
});

test('genitori indipendenti possono cambiare se necessario per evitare blocchi', () => {
  const attrs = [attr(1, [11, 12]), attr(2, [21, 22]), attr(3, [31, 32])];
  const constraints = [
    { source: 1, when: 11, target: 3, allowed: [31] },
    { source: 1, when: 12, target: 3, allowed: [32] },
    { source: 2, when: 21, target: 3, allowed: [31] },
    { source: 2, when: 22, target: 3, allowed: [32] },
  ];
  const next = chooseOption(attrs, constraints, new Map([[1, 11], [2, 21], [3, 31]]), 1, 12);
  assert.deepEqual([...next.entries()].sort(), [[1, 12], [2, 22], [3, 32]]);
});

test('codifica proietta le configurazioni complete sugli attributi codificati', () => {
  const constrained = [{ source: 3, when: 31, target: 2, allowed: [21] },
    { source: 3, when: 32, target: 2, allowed: [22] }];
  const combinations = codingCombinations(attributes, constrained, 20).map(comboKey);
  assert.deepEqual(combinations, ['1:11|2:21', '1:11|2:22', '1:12|2:21', '1:12|2:22']);
  assert.equal(codingCombinations(attributes, [], 2).length, 3);
  assert.deepEqual(codingCombinations([], [], 10), [[]]);
});

test('conversione tra righe di database e regole', () => {
  const rows = rulesToRows(rules);
  const values = rows.flatMap((row) => row.valori.map((value) => ({ ...row, id_opzione_destinazione: value })));
  assert.deepEqual(rulesFromRows(rows, values), rules);
  assert.deepEqual(rulesFromRows(rows, []), rules.map((rule) => ({ ...rule, allowed: [] })));
});
