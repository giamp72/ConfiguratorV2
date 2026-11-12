import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProductConfigRepository } from '../product-config.mjs';

function repository(data, selections = []) {
  const sb = { from(table) {
    let rows = data[table] || [];
    let single = false;
    const query = {
      select(columns) { selections.push([table, columns]); return this; },
      eq(key, value) { rows = rows.filter((row) => row[key] === value); return this; },
      in(key, values) { rows = rows.filter((row) => values.includes(row[key])); return this; },
      order() { return this; },
      range(from, to) { rows = rows.slice(from, to + 1); return this; },
      maybeSingle() { single = true; return this; },
      then(resolve) { return Promise.resolve(single ? rows[0] || null : rows).then(resolve); },
    };
    return query;
  } };
  const q = async (value) => value;
  const qAll = async (make) => make().range(0, 999);
  return createProductConfigRepository(sb, q, qAll);
}

test('carica le sole opzioni configurate e le condizioni del prodotto', async () => {
  const selections = [];
  const option = (id, name) => ({ id_opzione: id, nome: name, ordine: 0 });
  const repo = repository({
    prodotti: [{ id_prodotto: 7 }],
    misure: [{ id_prodotto: 7 }],
    prodotti_attributi: [
      { id_prodotto: 7, id_attributo: 1, attributi: { nome: 'A' } },
      { id_prodotto: 7, id_attributo: 2, attributi: { nome: 'B' }, codifica: false },
    ],
    configurazioni: [{ id_prodotto: 7, id_attributo: 1, id_opzione: 11 }, { id_prodotto: 7, id_attributo: 2, id_opzione: 21 }],
    attributi_opzioni: [
      { id_attributo: 1, abilitata: true, opzioni: { ...option(11, 'x'), id_glb: 42, risorse_glb: { percorso_risorsa: 'opzioni/x.glb' } } },
      { id_attributo: 1, abilitata: true, opzioni: option(12, 'y') },
      { id_attributo: 2, abilitata: true, opzioni: option(21, 'Y') },
    ],
    condizioni_attributi: [{ id_prodotto: 7, id_attributo_origine: 1, id_opzione_origine: 11, id_attributo_destinazione: 2 }],
    condizioni_attributi_valori: [{ id_prodotto: 7, id_attributo_origine: 1, id_opzione_origine: 11, id_attributo_destinazione: 2, id_opzione_destinazione: 21 }],
  }, selections);
  const result = await repo.loadProductConfig(7);
  assert.deepEqual(result.attributes.map((a) => [a.id, a.codifica, a.options.map((o) => o.id_opzione)]), [[1, true, [11]], [2, false, [21]]]);
  assert.deepEqual(result.rules, [{ source: 1, when: 11, target: 2, allowed: [21] }]);
  assert.equal(result.attributes[0].options[0].id_glb, 42);
  assert.equal(result.attributes[0].options[0].risorse_glb.percorso_risorsa, 'opzioni/x.glb');
  const query = selections.find(([table]) => table === 'attributi_opzioni')[1];
  assert.match(query, /\bid_glb\b/);
  assert.match(query, /risorse_glb\(percorso_risorsa\)/);
  assert.doesNotMatch(query, /id_materiale|materiali\(/);
  assert.equal(await repo.loadProductConfig(8), null);
});
