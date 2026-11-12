import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const between = (start, end, from = 0) => {
  const first = source.indexOf(start, from);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing source section: ${start}`);
  return source.slice(first, last);
};
const helpers = between('const assemblyKey =', '// Icone a tratto');

test('all save entry points share a single in-flight lock', async () => {
  let release, calls = 0, after = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const button = {};
  const context = vm.createContext({
    $: () => button, act: async (fn) => { await fn(); return true; }, go: () => { after += 1; },
  });
  vm.runInContext(between('function bindSaveAll(', '// ---------- layout ----------') + '\nglobalThis.bind = bindSaveAll;', context);
  const go = context.bind(async () => { calls += 1; await gate; }, () => { after += 1; });
  const pending = button.onclick();
  assert.equal(button.disabled, true);
  await go('#/attributi/nuovo');
  assert.equal(calls, 1);
  assert.equal(after, 0);
  assert.equal(button.disabled, true);
  release();
  await pending;
  assert.equal(after, 1);
  assert.equal(button.disabled, false);
});

test('saving existing and new measures preserves per-instance mappings and metre transforms', async () => {
  const measures = [
    { dataset: { misura: '10', previewId: '10' }, values: { dim_x: '100', dim_y: '100', dim_z: '100', unita_misura: 'cm' } },
    { dataset: { misura: 'new', previewId: 'new-measure' }, values: { dim_x: '200', dim_y: '200', dim_z: '200', unita_misura: 'mm' } },
  ];
  const makeComponent = (key, measureKey, position, rotation, id) => ({
    key, measureKey, id_componente: id, id_glb: 20, nome: key,
    posizione_x: position, posizione_y: 0, posizione_z: 0,
    rotazione_x: rotation, rotazione_y: 0, rotazione_z: 0,
  });
  const components = [makeComponent('90', '10', 1.25, 90, 90), makeComponent('new-a', '10', -2, 0), makeComponent('new-b', 'new-measure', 3, 0)];
  const writes = [];
  let next = 100;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sb = {
    from(table) {
      const request = { table, filters: {}, action: '', value: null,
        update(value) { this.action = 'update'; this.value = value; return this; },
        insert(value) { this.action = 'insert'; this.value = value; return this; },
        upsert(value) { this.action = 'upsert'; this.value = value; return this; },
        delete() { this.action = 'delete'; return this; },
        eq(field, value) { this.filters[field] = value; return this; },
        select() { return this; }, single() { return this; },
      };
      return request;
    },
    rpc(name, value) { return { table: name, value }; },
  };
  const record = async (request) => {
    writes.push({ table: request.table, action: request.action, value: request.value, filters: { ...request.filters } });
    if (request.table === 'prodotti') await gate;
    if (request.action === 'insert' && request.table === 'misure') return { id_misura: next++ };
    if (request.action === 'insert' && request.table === 'componenti_misura') return { id_componente: next++ };
    return null;
  };
  const fields = { '#nome': { value: 'Prodotto' }, '#descrizione': { value: '' }, '#attivo': { checked: true }, '#save-warning': {} };
  const block = { dataset: { attr: '40' }, values: { default: '50', ordine: '0', obbligatorio: true, codifica: true } };
  const context = vm.createContext({
    sb, q: record, components, removedComponents: new Set(), originalMappings: {},
    meshMappingsById: { '90:30:Materiale': 40, 'new-b:30:Visibilità': 41 },
    isNew: false, id: 1, pendingComponentAdds: 0, saveUncertain: false, savingProduct: false, app: { inert: false },
    conditionEditor: { getRules: () => [] }, conditionAttributes: () => [], findConfiguration: () => true, rulesToRows: () => [],
    componentsForMeasure: (key) => components.filter((c) => c.measureKey === key),
    num: (v) => v === '' || v == null ? null : Number(v), btn: () => '', errMsg: (e) => e.message,
    $: (selector, root) => {
      if (!root) return fields[selector];
      if (selector === '[data-act=drop]') return { dataset: {} };
      const name = selector.match(/^\[data-f=(.+)\]$/)?.[1];
      const value = root.values[name];
      return typeof value === 'boolean' ? { checked: value } : { value };
    },
    $$: (selector, root) => {
      if (selector === '#misure tr') return measures;
      if (selector === '#attr-blocks .attr-block[data-attr]') return [block];
      if (selector === '[data-opt]:checked' && root === block) return [{ dataset: { opt: '50' } }];
      return [];
    },
  });
  vm.runInContext(between('const saveProduct = async () => {', '  const reload =') + '\nglobalThis.save = saveProduct;', context);
  const saving = context.save();
  assert.equal(context.app.inert, true);
  await assert.rejects(context.save(), /Salvataggio già in corso/);
  release();
  await saving;
  assert.equal(context.app.inert, false);
  assert.equal(measures[1].dataset.misura, 100);
  const inserted = writes.filter((item) => item.table === 'componenti_misura' && item.action === 'insert');
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].value.id_misura, 10);
  assert.equal(inserted[1].value.id_misura, 100);
  assert.equal(inserted[1].value.posizione_x, 3);
  const updated = writes.find((item) => item.table === 'componenti_misura' && item.action === 'update');
  assert.equal(updated.value.posizione_x, 1.25);
  assert.equal(updated.value.rotazione_x, 90);
  const mappings = writes.filter((item) => item.table === 'associazioni_mesh_componenti');
  assert.deepEqual(mappings.map((item) => [item.value.id_componente, item.value.id_attributo]), [[90, 40], [102, 41]]);
  assert.equal(writes.find((item) => item.table === 'salva_attributi_condizioni').value.attributi.length, 1);
});

test('a material failure does not discard the loaded product assembly', async () => {
  let fail = true, clearCount = 0, applied = 0;
  const previewViewer = {
    clear() { clearCount += 1; }, highlight() {},
    async loadAssembly() {}, applyConfiguration() {},
  };
  const status = { textContent: '', classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    loadRevision: 0, applyRevision: 0, previewReady: false, previewViewer,
    previewToken: 1, productPreviewToken: 1,
    previewMeasures: [{ previewId: '10' }], measureSelect: { value: '10', disabled: false },
    componentsForMeasure: () => [{ posizione_x: 0, posizione_y: 0, posizione_z: 0, rotazione_x: 0, rotazione_y: 0, rotazione_z: 0, risorse_glb: { percorso_risorsa: 'cube' } }],
    signedUrlFor: async (path) => path, assemblyDefinition: (_component, url) => ({ id: '1', url }),
    status, stageHighlight: null, refreshPreviewAttributes() {},
    applyPreview: async () => { if (fail) throw new Error('materiale non disponibile'); applied += 1; },
    errMsg: (error) => error.message,
  });
  vm.runInContext('let loadSelectedMeasure;\n' + between('loadSelectedMeasure = async () => {\n', '    const bindPreviewAttributes') + '\nglobalThis.load = loadSelectedMeasure;', context);
  await context.load();
  assert.equal(clearCount, 1);
  assert.match(status.textContent, /materiale non disponibile/);
  assert.equal(context.previewReady, true);
  fail = false;
  await context.applyPreview();
  assert.equal(applied, 1);
  assert.equal(clearCount, 1);
});

test('reload and Final Check retain instance identity, metre positions and degree rotations', async () => {
  const rows = [1, 2].map((id) => ({
    id_componente: id, id_misura: 10, id_glb: 20, nome: `C${id}`, ordine: id,
    posizione_x: id * 1.25, posizione_y: 0, posizione_z: 0, rotazione_x: 90, rotazione_y: 0, rotazione_z: 0,
    risorse_glb: { percorso_risorsa: 'cube.glb' },
  }));
  const data = {
    componenti_misura: rows,
    associazioni_mesh_componenti: [{ id_componente: 1, id_mesh: 30, id_attributo: 40, ruolo: 'Materiale' }, { id_componente: 2, id_mesh: 30, id_attributo: 41, ruolo: 'Visibilità' }],
    mesh_glb: [{ id_mesh: 30, id_glb: 20, percorso_nodo: '/Cube[0]' }],
  };
  const sb = { from(table) { return { table, select() { return this; }, eq() { return this; }, order() { return this; }, in() { return this; } }; } };
  const ctx = vm.createContext({ sb, qAll: async (make) => data[make().table] });
  vm.runInContext(helpers + '\nglobalThis.api = { loadAssemblyData, assemblyDefinition, assemblyKey };', ctx);
  for (const unit of ['cm', 'mm']) {
    const result = await ctx.api.loadAssemblyData(1, [{ id_misura: 10, unita_misura: unit }]);
    const definition = ctx.api.assemblyDefinition(result.components[0], 'url');
    assert.equal(definition.id, '1');
    assert.equal(definition.position.x, 1.25);
    assert.equal(definition.rotation.x, Math.PI / 2);
  }
  const loaded = await ctx.api.loadAssemblyData(1, [{ id_misura: 10, unita_misura: 'mm' }]);
  const applied = [], definitions = [];
  Object.assign(ctx, {
    components: loaded.components, meshRows: loaded.meshes, mappings: loaded.mappings,
    assemblyKey: ctx.api.assemblyKey, assemblyDefinition: ctx.api.assemblyDefinition,
    token: 1, productPreviewToken: 1, previewReady: true, applyRevision: 0,
    currentMeasure: () => ({ id_misura: 10 }), selection: () => [[40, 50], [41, 51]],
    attributes: [{ id: 40, nome: 'Colore' }, { id: 41, nome: 'Visibilità' }],
    optionById: new Map([[50, { id_glb: 60, risorse_glb: { percorso_risorsa: 'red' } }], [51, { valore_visibilita: false }]]),
    signedUrlFor: async (path) => path,
    status: { textContent: '', classList: { toggle() {}, remove() {} } },
    viewer: { clear() {}, loadAssembly: async (items) => definitions.push(items), loadMaterial: async (id) => ({ id }), applyConfiguration: (items) => applied.push(items) },
  });
  const start = source.indexOf('// anteprima 3D');
  vm.runInContext(between('const applyPreview = async () => {', '  const onConfigChange', start) + '\nglobalThis.load = loadMeasure;', ctx);
  await ctx.load();
  assert.equal(definitions[0].length, 2);
  assert.equal(definitions[0][1].position.x, 2.5);
  const entries = applied.at(-1);
  assert.equal(entries[0].componentId, '1');
  assert.equal(entries[0].material.id, 60);
  assert.equal(entries[1].componentId, '2');
  assert.equal(entries[1].visible, false);
  assert.equal(entries[1].material, undefined);
});

test('return routes reject injected or external hrefs and both links escape their values', () => {
  const declaration = between('const safeReturnRoute =', '\n');
  const ctx = vm.createContext({});
  vm.runInContext(declaration + '\nglobalThis.validate = safeReturnRoute;', ctx);
  for (const value of ['#/', '#/prodotti/7', '#/attributi/nuovo', '#/test/5']) assert.equal(ctx.validate(value), value);
  for (const value of ['javascript:alert(1)', '//evil.test', '#/prodotti/1" onmouseover="alert(1)', '#/prodotti/1?next=x']) assert.equal(ctx.validate(value), '');
  assert.match(source, /href="\$\{esc\(href\)\}"/);
  assert.match(source, /href="\$\{esc\(returnTo \|\| '#\/attributi'\)\}"/);
});
