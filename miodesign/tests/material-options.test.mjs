import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const viewSource = source.slice(source.indexOf('async function viewAttributo('), source.indexOf('// ---------- commerciale: utilità ----------'));

async function setup(type = 'Materiale', upload = async () => ({ id_glb: 42 })) {
  const writes = [], selections = [], events = {}, elements = {};
  let gate = null;
  const fields = {
    nome: { value: 'Rovere' }, descrizione: { value: '' }, ordine: { value: '0' },
    attiva: { checked: true }, valore_visibilita: { value: 'false' },
  };
  const row = {
    dataset: { opz: '9', glb: type === 'Materiale' ? '7' : '' },
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
  const data = {
    attributi: [{ id_attributo: 1, nome: 'Colore', tipo_attributo: type, id_attributo_padre: null, attivo: true }],
    opzioni: [{ id_opzione: 9, id_attributo: 1, nome: 'Rovere', ordine: 0, attiva: true, id_glb: 7, risorse_glb: { nome_file: 'old.glb' } }],
  };
  const sb = { from(table) {
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
    sb, q: async (p) => { if (gate) await gate; return p; }, qAll: async () => [], shell: (html) => { markup = html; },
    $: (selector, root) => root ? root.querySelector(selector) : elements[selector],
    $$: (selector) => selector === '#opzioni tr' ? [row] : [],
    esc: (v) => String(v ?? ''), icon: () => '', btn: () => '', saveBar: () => '',
    num: (v) => v === '' || v == null ? null : Number(v),
    attributeLabel: (a) => a.nome, optionLabel: (o) => o.nome,
    withReturn: (hash) => hash, bindSaveAll: (fn) => { save = fn; },
    uploadGlbResource: upload, crypto: { randomUUID: () => 'uuid' },
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
  return { row, input, events, click, save: () => save(), setGate: (value) => { gate = value; }, writes, selections, markup };
}

test('material option uploads, saves and clears its own GLB', async () => {
  const calls = [];
  const ui = await setup('Materiale', async (...args) => { calls.push(args); return { id_glb: 42 }; });
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
