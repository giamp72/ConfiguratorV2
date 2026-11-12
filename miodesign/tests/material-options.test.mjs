import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const viewSource = source.slice(source.indexOf('async function viewAttributo('), source.indexOf('// ---------- commerciale: utilità ----------'))
  .replace("import('./product-preview.js')", 'loadPreviewModule()');

async function setup(type = 'Materiale', upload = async () => ({ id_glb: 42, path: 'new.glb' }), derived = false) {
  const writes = [], selections = [], events = {}, elements = {};
  const previews = [], signedRequests = [];
  let signer = async (path) => ({ data: { signedUrl: `signed:${path}` }, error: null });
  let gate = null;
  const fields = {
    nome: { value: 'Rovere' }, descrizione: { value: '' }, ordine: { value: '0' },
    attiva: { checked: true }, valore_visibilita: { value: 'false' },
  };
  const row = {
    dataset: { opz: '9', glb: type === 'Materiale' ? '7' : '', glbPath: 'old.glb' },
    querySelector(selector) {
      if (selector === '[data-glb-name]') return this.glbName;
      if (selector === '[data-upload-status]') return this.status;
      return fields[selector.match(/^\[data-f=(.+)\]$/)?.[1]];
    },
    glbName: { value: 'old.glb' }, status: { textContent: '' },
  };
  for (const id of ['padre', 'tipo', 'nome', 'descrizione', 'attivo', 'form-attr', 'opt-search', 'add-option']) elements[`#${id}`] = {};
  Object.assign(elements['#nome'], { value: 'Colore' });
  Object.assign(elements['#descrizione'], { value: '' });
  Object.assign(elements['#attivo'], { checked: true });
  elements['#opzioni'] = { addEventListener(name, fn) { events[name] = fn; } };
  elements['#attribute-options'] = { addEventListener(name, fn) { events[`options-${name}`] = fn; } };
  elements['#attribute-material-preview'] = {};
  elements['#attribute-material-status'] = { textContent: '', classList: { add() {}, remove() {} } };
  const data = {
    attributi: [{ id_attributo: 1, nome: 'Colore', tipo_attributo: type, id_attributo_padre: derived ? 2 : null, attivo: true }],
    opzioni: [{ id_opzione: 9, id_attributo: derived ? 2 : 1, nome: 'Rovere', ordine: 0, attiva: true, id_glb: 7, risorse_glb: { nome_file: 'old.glb', percorso_risorsa: 'old.glb' } }],
  };
  const sb = { storage: { from: () => ({ createSignedUrl: async (path) => {
    signedRequests.push(path);
    return signer(path);
  } }) }, from(table) {
    let rows = data[table] || [], single = false, write;
    return {
      select(value) { selections.push([table, value]); return this; },
      is(key, value) { rows = rows.filter((r) => r[key] === value); return this; },
      eq(key, value) { rows = rows.filter((r) => String(r[key]) === String(value)); return this; },
      order() { return this; },
      maybeSingle() { single = true; return this; },
      update(value) { write = value; writes.push([table, value]); return this; },
      then(resolve) { return Promise.resolve(write || (single ? rows[0] : rows)).then(resolve); },
    };
  } };
  let save, markup;
  const sandbox = {
    productPreviewToken: 0, activeProductPreview: null,
    sb, q: async (p) => { if (gate) await gate; return p; }, qAll: async () => [], shell: (html) => { markup = html; },
    $: (selector, root) => root ? root.querySelector(selector) : elements[selector],
    $$: (selector) => selector === '#opzioni tr' ? [row] : [],
    esc: (v) => String(v ?? ''), icon: () => '', btn: () => '', saveBar: () => '',
    num: (v) => v === '' || v == null ? null : Number(v),
    attributeLabel: (a) => a.nome, optionLabel: (o) => o.nome,
    withReturn: (hash) => hash, bindSaveAll: (fn) => { save = fn; },
    uploadGlbResource: upload, crypto: { randomUUID: () => 'uuid' },
    loadPreviewModule: async () => ({ createProductPreview: () => ({
      clear: () => previews.push('clear'),
      loadMaterial: async (id, url) => ({ id, url }),
      showMaterial: (material) => previews.push(material),
      dispose: () => {},
    }) }),
    toast: () => {}, errMsg: (e) => e.message, go: () => {}, confirm: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(viewSource, sandbox);
  await sandbox.viewAttributo('1');
  const input = {
    files: [{ name: 'new.glb' }], disabled: false, value: 'new.glb',
    matches: (selector) => selector === '[data-f=glb]', closest: () => row,
  };
  const click = (action) => elements['#opzioni'].onclick({ target: { closest: (selector) => selector === '[data-act]' ? { dataset: { act: action } } : row } });
  const selectPreview = () => events['options-click']({ target: { closest: () => ({ closest: () => row }) } });
  return { row, input, events, click, selectPreview, save: () => save(), setGate: (value) => { gate = value; }, setSigner: (value) => { signer = value; }, writes, selections, markup, previews, signedRequests, elements };
}

test('material option uploads, saves and clears its own GLB', async () => {
  const calls = [];
  const ui = await setup('Materiale', async (...args) => { calls.push(args); return { id_glb: 42, path: 'new.glb' }; });
  assert.match(ui.markup, /old\.glb/);
  assert.match(ui.markup, /Carica GLB/);
  assert.ok(ui.selections.some(([table, select]) => table === 'opzioni' && select.includes('risorse_glb')));
  await ui.events.change({ target: ui.input });
  assert.equal(calls[0][1], 'Materiale');
  assert.equal(calls[0][2], 'opzioni/9');
  assert.equal(ui.row.glbName.value, 'new.glb');
  await ui.save();
  assert.equal(ui.writes.find(([table]) => table === 'opzioni')[1].id_glb, 42);
  await ui.click('clear-glb');
  await ui.save();
  assert.equal(ui.writes.filter(([table]) => table === 'opzioni').at(-1)[1].id_glb, null);
});

test('previews the selected material and clears it when the association is removed', async () => {
  const ui = await setup();
  assert.match(ui.markup, /Anteprima materiale/);
  ui.selectPreview();
  await new Promise(setImmediate);
  assert.deepEqual(ui.signedRequests, ['old.glb']);
  assert.equal(ui.previews.at(-1).id, '7');
  assert.equal(ui.previews.at(-1).url, 'signed:old.glb');
  assert.match(ui.elements['#attribute-material-status'].textContent, /Rovere/);
  await ui.click('clear-glb');
  assert.equal(ui.previews.at(-1), 'clear');
  assert.match(ui.elements['#attribute-material-status'].textContent, /Nessun materiale/);
});

test('preview follows a successfully uploaded material', async () => {
  const ui = await setup();
  await ui.events.change({ target: ui.input });
  await new Promise(setImmediate);
  assert.deepEqual(ui.signedRequests, ['new.glb']);
  assert.equal(ui.previews.at(-1).id, 42);
  assert.equal(ui.previews.at(-1).url, 'signed:new.glb');
});

test('derived attributes can preview a parent option without changing its selection', async () => {
  const ui = await setup('Materiale', undefined, true);
  assert.match(ui.markup, /data-opt="9"/);
  assert.match(ui.markup, /data-glb-path="old\.glb"/);
  const button = { dataset: { glb: '7', glbPath: 'old.glb', label: 'Rovere' }, closest: () => null };
  ui.events['options-click']({ target: { closest: () => button } });
  await new Promise(setImmediate);
  assert.equal(ui.previews.at(-1).id, '7');
  assert.match(ui.elements['#attribute-material-status'].textContent, /Rovere/);
});

test('a late preview cannot replace a newer selection or a removed association', async () => {
  const ui = await setup();
  let resolveFirst;
  ui.setSigner((path) => path === 'old.glb'
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : Promise.resolve({ data: { signedUrl: `signed:${path}` }, error: null }));
  ui.selectPreview();
  ui.row.dataset.glb = '8';
  ui.row.dataset.glbPath = 'other.glb';
  ui.selectPreview();
  await new Promise(setImmediate);
  resolveFirst({ data: { signedUrl: 'signed:old.glb' }, error: null });
  await new Promise(setImmediate);
  assert.equal(ui.previews.filter((p) => p.id).length, 1);
  assert.equal(ui.previews.at(-1).id, '8');

  ui.row.dataset.glbPath = 'old.glb';
  ui.selectPreview();
  await ui.click('clear-glb');
  resolveFirst({ data: { signedUrl: 'signed:old.glb' }, error: null });
  await new Promise(setImmediate);
  assert.equal(ui.previews.at(-1), 'clear');
});

test('preview reports signed URL failures', async () => {
  const ui = await setup();
  ui.setSigner(async () => ({ error: new Error('Accesso negato') }));
  ui.selectPreview();
  await new Promise(setImmediate);
  assert.match(ui.elements['#attribute-material-status'].textContent, /Accesso negato/);
  assert.equal(ui.previews.length, 0);
});

test('pending and failed uploads do not overwrite or save the association', async () => {
  let rejectUpload;
  const ui = await setup('Materiale', () => new Promise((_, reject) => { rejectUpload = reject; }));
  const pending = ui.events.change({ target: ui.input });
  await assert.rejects(ui.save(), /Attendi/);
  await ui.click('clear-glb');
  assert.equal(ui.row.dataset.glb, '7');
  rejectUpload(new Error('upload fallito'));
  await pending;
  assert.equal(ui.row.dataset.glb, '7');
  assert.equal(ui.row.glbName.value, 'old.glb');
  assert.match(ui.row.status.textContent, /upload fallito/);
});

test('visibility options retain their existing effect', async () => {
  const ui = await setup('Visibilità');
  assert.match(ui.markup, /Nascondi/);
  assert.doesNotMatch(ui.markup, /Carica GLB/);
  await ui.save();
  const option = ui.writes.find(([table]) => table === 'opzioni')[1];
  assert.equal(option.valore_visibilita, false);
  assert.equal('id_glb' in option, false);
});

test('an upload cannot start while a save is in progress', async () => {
  let release, uploads = 0;
  const ui = await setup('Materiale', async () => { uploads += 1; return { id_glb: 42 }; });
  ui.setGate(new Promise((resolve) => { release = resolve; }));
  const saving = ui.save();
  await ui.events.change({ target: ui.input });
  assert.equal(uploads, 0);
  assert.equal(ui.row.dataset.glb, '7');
  release();
  await saving;
  ui.setGate(null);
  await ui.events.change({ target: ui.input });
  assert.equal(uploads, 1);
  assert.equal(ui.row.dataset.glb, 42);
});
