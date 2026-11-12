import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { codingCombinations, comboKey, findConfiguration, rulesToRows } from './conditions.mjs';
import { createConditionEditor } from './condition-editor.mjs';
import { updateConditionSelects } from './condition-selects.mjs';
import { createProductConfigRepository } from './product-config.mjs';

const configured = !SUPABASE_URL.includes('YOUR-PROJECT');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const { loadConditionRules, loadProductConfig, listiniWithDefault } = createProductConfigRepository(sb, q, qAll);
const app = document.getElementById('app');
let session = null;
let activeProductPreview = null;
let productPreviewToken = 0;

// ---------- utilità ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const optionLabel = (option) => option.descrizione ? `${option.nome} — ${option.descrizione}` : option.nome;
const attributeLabel = (attribute) => attribute.descrizione ? `${attribute.nome} — ${attribute.descrizione}` : attribute.nome;
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const num = (v) => (v === '' || v == null ? null : Number(v));

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), error ? 6000 : 2500);
}

function errMsg(e) {
  if (e?.code === '23503') return 'Operazione non consentita: l\'elemento è collegato ad altri dati.';
  if (e?.code === '23505') return 'Esiste già un elemento con gli stessi valori.';
  return e?.message || String(e);
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Esegue un'azione mostrando eventuali errori; ritorna true se riuscita.
async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast(errMsg(e), true);
    return false;
  }
}

function parseGlbMeshes(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error('Il file selezionato non è un GLB valido.');
  }
  let offset = 12, document;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > view.byteLength) throw new Error('Il file GLB è incompleto.');
    if (type === 0x4e4f534a) {
      document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset, length)).replace(/\0+$/, '').trim());
      break;
    }
    offset += length;
  }
  if (!document?.nodes) throw new Error('Il GLB non contiene una scena valida.');

  const roots = document.scenes?.[document.scene ?? 0]?.nodes;
  const parents = new Set((document.nodes || []).flatMap((node) => node.children || []));
  const rootsToVisit = roots || document.nodes.map((_, index) => index).filter((index) => !parents.has(index));
  const meshes = [];
  const visit = (nodeIndex, parentPath) => {
    const node = document.nodes[nodeIndex];
    if (!node) return;
    const label = node.name || document.meshes?.[node.mesh]?.name || `Nodo ${nodeIndex + 1}`;
    const path = `${parentPath}/${label}[${nodeIndex}]`;
    if (node.mesh != null) {
      const mesh = document.meshes?.[node.mesh];
      const materialIndex = mesh?.primitives?.find((primitive) => primitive.material != null)?.material;
      meshes.push({
        nome_mesh: node.name || mesh?.name || label,
        percorso_nodo: path,
        indice_mesh: node.mesh,
        materiale_base: document.materials?.[materialIndex]?.name || null,
      });
    }
    (node.children || []).forEach((child) => visit(child, path));
  };
  rootsToVisit.forEach((root) => visit(root, ''));
  if (!meshes.length) throw new Error('Il GLB non contiene mesh da associare.');
  return meshes;
}

async function uploadGlbResource(file, type, folder) {
  if (!file || !file.name.toLowerCase().endsWith('.glb')) throw new Error('Seleziona un file con estensione .glb.');
  const buffer = await file.arrayBuffer();
  const meshes = type === 'Oggetto' ? parseGlbMeshes(buffer) : null;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const impronta = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${folder}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await sb.storage.from('modelli-glb').upload(path, file, {
    contentType: 'model/gltf-binary',
    upsert: false,
  });
  if (uploadError) throw uploadError;
  let resourceId;
  try {
    const resource = await q(sb.from('risorse_glb').insert({
      nome_file: file.name,
      percorso_risorsa: path,
      tipo_risorsa: type,
      impronta_file: impronta,
    }).select('id_glb').single());
    resourceId = resource.id_glb;
    const savedMeshes = meshes?.length
      ? await q(sb.from('mesh_glb').insert(meshes.map((mesh) => ({ ...mesh, id_glb: resource.id_glb }))).select('id_mesh, id_glb, nome_mesh, percorso_nodo, indice_mesh, materiale_base'))
      : meshes;
    return { ...resource, meshes: savedMeshes, path };
  } catch (error) {
    const cleanupErrors = [];
    if (resourceId) {
      const { error: resourceCleanupError } = await sb.from('risorse_glb').delete().eq('id_glb', resourceId);
      if (resourceCleanupError) cleanupErrors.push(errMsg(resourceCleanupError));
    }
    const { error: storageCleanupError } = await sb.storage.from('modelli-glb').remove([path]);
    if (storageCleanupError) cleanupErrors.push(errMsg(storageCleanupError));
    if (cleanupErrors.length) throw new Error(`${errMsg(error)} (pulizia non riuscita: ${cleanupErrors.join('; ')})`);
    throw error;
  }
}

// Icone a tratto in stile SF Symbols.
const ICONS = {
  cube: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  swatch: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1" /><circle cx="12" cy="7.5" r="1"/><circle cx="15.5" cy="10" r="1"/><path d="M12 21c-1.5 0-2-1.2-1.4-2.4.6-1.2 0-2.1-1.1-2.1H8"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1.4 1.4 0 0 1 0 2l-6.5 6.5a1.4 1.4 0 0 1-2 0l-8-8Z"/><circle cx="8" cy="8" r="1.3"/>',
  seal: '<path d="M12 3l2.2 1.6 2.7-.1.9 2.600 2.200 1.600-.8 2.600.8 2.600-2.200 1.600-.9 2.600-2.700-.1L12 21l-2.200-1.600-2.700.1-.9-2.600-2.200-1.600.8-2.600-.8-2.600 2.200-1.600.9-2.600 2.700.1L12 3Z"/><path d="m8.800 12.200 2.200 2.200 4.200-4.400"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
  pencil: '<path d="m15 5 4 4M4 20l1-4L16.500 4.500a2 2 0 0 1 3 3L8 19l-4 1Z"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="m16 16 4.500 4.500"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10"/>',
  upload: '<path d="M12 16V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.500 3 3 5-6"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const btn = (name, label) => `${icon(name)}<span>${label}</span>`;

const go = (hash) => { location.hash = hash; };
const withReturn = (hash, returnTo) => `${hash}${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`;

const saveBar = (label = 'Salva tutto', extra = '') => `<div class="save-bar">${extra}<span class="muted">Le modifiche vengono salvate solo con questo pulsante.</span><button class="primary" id="save-all" type="button">${btn('save', label)}</button></div>`;

// Collega il pulsante unico di salvataggio: fn lancia un errore se qualcosa non va, after parte solo a salvataggio riuscito.
// Ritorna saveAndGo(target): salva e poi naviga (usato dai link che lasciano la pagina con modifiche non salvate).
function bindSaveAll(fn, after) {
  const button = $('#save-all');
  button.onclick = async () => {
    button.disabled = true;
    const ok = await act(fn, 'Modifiche salvate');
    button.disabled = false;
    if (ok && after) after();
  };
  return async (target) => {
    button.disabled = true;
    const ok = await act(fn, 'Modifiche salvate');
    button.disabled = false;
    if (ok) go(typeof target === 'function' ? target() : target);
  };
}

// ---------- layout ----------
function shell(content, crumbs = []) {
  const trail = [['Menu', '#/'], ...crumbs]
    .map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : esc(label)))
    .join(icon('chevron'));
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="MIO Design"><img class="brand-logo" src="./logo.svg" alt="MIO Design"></a>
      <div class="topbar-right"><span class="muted">${esc(session?.user?.email)}</span>
        <button class="small" id="logout">${btn('logout', 'Esci')}</button></div>
    </header>
    <main>${crumbs.length ? `<div class="crumbs">${trail}</div>` : ''}${content}</main>`;
  $('#logout').onclick = () => sb.auth.signOut();
}

// ---------- login ----------
function viewLogin() {
  app.innerHTML = `
    <div class="login-wrap"><form class="card login-card" id="login">
      <img class="brand-logo" src="./logo.svg" alt="MIO Design"><h1>Accedi a MIO Design</h1><p class="muted">Gestisci i dati di prodotto utilizzati da MIOLite.</p>
      ${configured ? '' : '<p class="notice">Configura SUPABASE_URL e SUPABASE_ANON_KEY in <code>config.js</code>.</p>'}
      <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="password">Password</label><input id="password" type="password" required autocomplete="current-password"></div>
      <button class="primary" style="width:100%" ${configured ? '' : 'disabled'}>Accedi</button>
    </form></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    if (error) toast(error.message === 'Invalid login credentials' ? 'Credenziali non valide.' : error.message, true);
  };
}

// ---------- menu ----------
async function viewMenu() {
  shell(`
    <div class="page-head"><div><h1>Menu</h1><span class="muted">Seleziona l'area da gestire.</span></div></div>
    <div class="menu-grid">
      ${[
        ['#/materiali', 'swatch', 'tone-orange', 'Materiali', 'Definisci i materiali e associa il relativo GLB.'],
        ['#/attributi', 'sliders', 'tone-purple', 'Attributi', 'Gestisci gli attributi (generali e derivati) e le relative opzioni.'],
        ['#/prodotti', 'cube', 'tone-blue', 'Prodotti', 'Crea e modifica i prodotti, con misure, attributi e mappatura mesh.'],
        ['#/codifica', 'tag', 'tone-teal', 'Codifica e Pricing', 'Per ogni combinazione assegna codice commerciale, descrizione e prezzo.'],
        ['#/test', 'seal', 'tone-green', 'Final Check', 'Verifica codice, prezzo e anteprima 3D e segna il prodotto come testato.'],
      ].map(([href, ic, tone, title, text], n) => `<a class="menu-tile" href="${href}"><span class="menu-icon ${tone}">${icon(ic)}</span><span><strong>${title}</strong><span class="muted">${text}</span></span><span class="menu-step" data-count="${n}">…</span></a>`).join('')}
    </div>`);
  try {
    const count = async (table) => (await sb.from(table).select('*', { count: 'exact', head: true })).count ?? 0;
    const [nMat, nAttr, nProd, nCod, prezzi, nValid] = await Promise.all([
      count('materiali'), count('attributi'), count('prodotti'), count('codifica'),
      qAll(() => sb.from('prezzi').select('id_codice').order('id_codice')),
      sb.from('prodotti').select('*', { count: 'exact', head: true }).eq('validato', true).then((r) => r.count ?? 0),
    ]);
    const priced = new Set(prezzi.map((p) => p.id_codice)).size;
    const values = [nMat, nAttr, nProd, `${priced}/${nCod}`, `${nValid}/${nProd}`];
    $$('[data-count]').forEach((el) => { el.textContent = values[Number(el.dataset.count)]; });
  } catch (e) {
    $$('[data-count]').forEach((el) => { el.textContent = ''; });
  }
}

// ---------- prodotti: elenco ----------
async function viewProdotti() {
  shell('<div class="empty">Caricamento…</div>', [['Prodotti']]);
  const [prodotti, misure] = await Promise.all([
    q(sb.from('prodotti').select('*').order('id_prodotto')),
    q(sb.from('misure').select('id_prodotto')),
  ]);
  const nMisure = {};
  misure.forEach((m) => (nMisure[m.id_prodotto] = (nMisure[m.id_prodotto] || 0) + 1));

  const draw = (filter = '') => {
    const f = filter.toLowerCase();
    const rows = prodotti.filter((p) => !f || `${p.id_prodotto} ${p.nome} ${p.descrizione || ''}`.toLowerCase().includes(f));
    $('#rows').innerHTML = rows.length
      ? rows.map((p) => `<tr>
          <td>${p.id_prodotto}</td><td><a href="#/prodotti/${p.id_prodotto}"><strong>${esc(p.nome)}</strong></a></td>
          <td class="muted">${esc(p.descrizione)}</td><td>${nMisure[p.id_prodotto] || 0}</td>
          <td><span class="badge ${p.attivo ? 'ok' : 'no'}">${p.attivo ? 'Attivo' : 'Non attivo'}</span> ${p.validato ? '<span class="badge ok">Testato</span>' : '<span class="badge warn">Da validare</span>'}</td>
          <td class="actions"><a class="btn small" href="#/prodotti/${p.id_prodotto}">${btn('pencil', 'Modifica')}</a>
            <button class="small danger" data-del="${p.id_prodotto}">${btn('trash', 'Elimina')}</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Nessun prodotto.</td></tr>';
  };

  shell(`
    <div class="page-head"><div><h1>Prodotti</h1><span class="muted">${prodotti.length} prodotti</span></div>
      <div class="row"><div class="search-wrap">${icon('search')}<input class="search" id="search" placeholder="Cerca…"></div><a class="btn primary shrink" href="#/prodotti/nuovo">${btn('plus', 'Nuovo prodotto')}</a></div></div>
    <div class="card table-scroll"><table><thead><tr><th>ID</th><th>Nome</th><th>Descrizione</th><th>Misure</th><th>Stato</th><th></th></tr></thead>
    <tbody id="rows"></tbody></table></div>`, [['Prodotti']]);
  draw();
  $('#search').oninput = (e) => draw(e.target.value);
  $('#rows').onclick = async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    const p = prodotti.find((x) => x.id_prodotto == id);
    if (!confirm(`Eliminare il prodotto "${p.nome}" con misure, attributi e combinazioni collegate?`)) return;
    if (await act(() => q(sb.from('prodotti').delete().eq('id_prodotto', id)), 'Prodotto eliminato')) viewProdotti();
  };
}

// ---------- prodotti: scheda ----------
async function viewProdotto(idParam) {
  const previewToken = ++productPreviewToken;
  activeProductPreview?.dispose();
  activeProductPreview = null;
  const isNew = idParam === 'nuovo';
  const id = isNew ? null : Number(idParam);
  shell('<div class="empty">Caricamento…</div>', [['Prodotti', '#/prodotti'], [isNew ? 'Nuovo prodotto' : `Prodotto ${id}`]]);

  let prodotto = { nome: '', descrizione: '', attivo: true };
  let misure = [], assegnati = [], configs = [], tuttiAttributi = [], opzioniPerAttr = [], conditions = [];
  let meshRows = [], meshMappingsById = {}, previewOptionsByAttr = {};
  const meshMappingKey = (meshId, role) => `${meshId}:${role}`;
  if (!isNew) {
    const [p, m, pa, cf, attrs, loadedConditions] = await Promise.all([
      q(sb.from('prodotti').select('*').eq('id_prodotto', id).maybeSingle()),
      q(sb.from('misure').select('*, risorse_glb(id_glb, nome_file, percorso_risorsa)').eq('id_prodotto', id).order('id_misura')),
      q(sb.from('prodotti_attributi').select('*, attributi(nome, descrizione, tipo_attributo)').eq('id_prodotto', id).order('ordine')),
      q(sb.from('configurazioni').select('id_attributo, id_opzione').eq('id_prodotto', id)),
      q(sb.from('attributi').select('id_attributo, nome, descrizione, tipo_attributo, attivo').order('nome')),
      loadConditionRules(id),
    ]);
    if (!p) { toast('Prodotto non trovato', true); return go('#/prodotti'); }
    prodotto = p; misure = m; assegnati = pa; configs = cf; tuttiAttributi = attrs; conditions = loadedConditions;
    const ids = assegnati.map((a) => a.id_attributo);
    if (ids.length) {
      const ao = await q(sb.from('attributi_opzioni').select('id_attributo, abilitata, opzioni(id_opzione, nome, descrizione, attiva, ordine, id_materiale, valore_visibilita, materiali(id_materiale, nome, id_glb, risorse_glb(percorso_risorsa)))').in('id_attributo', ids));
      ao.filter((r) => r.abilitata && r.opzioni).forEach((r) => (opzioniPerAttr[r.id_attributo] ||= []).push(r.opzioni));
      Object.values(opzioniPerAttr).forEach((l) => l.sort((a, b) => a.ordine - b.ordine || a.nome.localeCompare(b.nome)));
      previewOptionsByAttr = opzioniPerAttr;
    }
    const glbIds = [...new Set(misure.map((misura) => misura.id_glb).filter(Boolean))];
    if (glbIds.length) {
      const [allMeshes, allMappings] = await Promise.all([
        q(sb.from('mesh_glb').select('id_mesh, id_glb, nome_mesh, percorso_nodo, indice_mesh, materiale_base').in('id_glb', glbIds)),
        q(sb.from('associazioni_mesh').select('id_mesh, id_attributo, ruolo').eq('id_prodotto', id)),
      ]);
      meshRows = allMeshes;
      allMappings.forEach((mapping) => { meshMappingsById[meshMappingKey(mapping.id_mesh, mapping.ruolo)] = mapping.id_attributo; });
    }
  }

  const misuraRow = (m) => `<tr data-misura="${m?.id_misura ?? 'new'}" data-preview-id="${m?.id_misura ?? `new-${crypto.randomUUID()}`}" data-glb="${m?.id_glb ?? ''}">
      <td class="col-dim"><input type="number" step="any" data-f="dim_x" value="${esc(m?.dim_x)}" aria-label="Larghezza"></td>
      <td class="col-dim"><input type="number" step="any" data-f="dim_y" value="${esc(m?.dim_y)}" aria-label="Altezza"></td>
      <td class="col-dim"><input type="number" step="any" data-f="dim_z" value="${esc(m?.dim_z)}" aria-label="Profondità"></td>
      <td class="col-dim"><select data-f="unita_misura">${['cm', 'mm'].map((u) => `<option ${((m?.unita_misura) || 'cm') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
      <td class="col-glb"><div class="glb-field"><input data-glb-name readonly value="${esc(m?.risorse_glb?.nome_file)}" placeholder="Nessun GLB" aria-label="Nome GLB">
        <label class="upload-button small btn">${icon('upload')}<span>Carica GLB</span><input type="file" data-f="glb" accept=".glb,model/gltf-binary" aria-label="Carica GLB oggetto"></label></div><span class="upload-status muted" data-upload-status></span></td>
      <td class="actions">${m ? `<button class="small danger" data-act="clear-glb">Rimuovi GLB</button> <button class="small danger" data-act="del">${btn('trash', 'Elimina')}</button>` : `<button class="small ghost" data-act="drop">${btn('close', 'Annulla')}</button>`}</td></tr>`;

  const attrBlock = (pa) => {
    const opts = opzioniPerAttr[pa.id_attributo] || [];
    const sel = pa.pending ? new Set(opts.map((o) => o.id_opzione)) : new Set(configs.filter((c) => c.id_attributo === pa.id_attributo).map((c) => c.id_opzione));
    return `<div class="attr-block" data-attr="${pa.id_attributo}" ${pa.pending ? 'data-new="1"' : ''}>
      <h3>${esc(pa.attributi.nome)} <span class="badge">${esc(pa.attributi.tipo_attributo)}</span></h3>
      ${pa.attributi.descrizione ? `<p class="muted">${esc(pa.attributi.descrizione)}</p>` : ''}
      <label>Opzioni ammesse per questo prodotto</label>
      <div class="opt-grid">${opts.length ? opts.map((o) => `<label class="check"><input type="checkbox" data-opt="${o.id_opzione}" ${sel.has(o.id_opzione) ? 'checked' : ''}> ${esc(optionLabel(o))}${o.attiva ? '' : ' <span class="muted">(non attiva)</span>'}</label>`).join('') : '<span class="muted">L\'attributo non ha opzioni.</span>'}</div>
      <div class="row">
        <div><label>Default</label><select data-f="default"><option value="">— nessuno —</option>${opts.filter((o) => sel.has(o.id_opzione)).map((o) => `<option value="${o.id_opzione}" ${pa.id_opzione_default === o.id_opzione ? 'selected' : ''}>${esc(optionLabel(o))}</option>`).join('')}</select></div>
        <div><label>Ordine</label><input type="number" data-f="ordine" value="${pa.ordine}"></div>
        <label class="check shrink"><input type="checkbox" data-f="obbligatorio" ${pa.obbligatorio ? 'checked' : ''}> Obbligatorio</label>
        <label class="check shrink"><input type="checkbox" data-f="codifica" ${pa.codifica !== false ? 'checked' : ''}> Codifica</label>
        <div class="shrink"><button class="small danger" type="button" data-act="remove">${btn('trash', 'Rimuovi')}</button></div>
      </div></div>`;
  };

  const assegnabili = tuttiAttributi.filter((a) => a.attivo && !assegnati.some((x) => x.id_attributo === a.id_attributo));
  let previewMeasures = misure.filter((measure) => measure.id_glb && measure.risorse_glb?.percorso_risorsa)
    .map((measure) => ({ ...measure, previewId: String(measure.id_misura) }));
  const meshesForMeasure = (measureId) => {
    const measure = previewMeasures.find((item) => String(item.previewId) === String(measureId));
    return measure ? meshRows.filter((mesh) => mesh.id_glb === measure.id_glb)
      .sort((a, b) => a.percorso_nodo.localeCompare(b.percorso_nodo)) : [];
  };
  const mappedAttributeIds = (measureId) => [...new Set(meshesForMeasure(measureId)
    .flatMap((mesh) => ['Materiale', 'Visibilità'].map((role) => meshMappingsById[meshMappingKey(mesh.id_mesh, role)]).filter(Boolean)))];
  const attributesForRole = (role) => assegnati.filter((attribute) => attribute.attributi.tipo_attributo === role);
  const meshMappingRows = (rows) => rows.length ? `<div class="table-scroll"><table><thead><tr><th>Mesh</th><th>Percorso</th><th>Materiale originale</th><th>Attributo materiale</th><th>Attributo visibilità</th><th></th></tr></thead><tbody>
    ${rows.map((mesh) => `<tr data-mesh-id="${mesh.id_mesh}"><td>${esc(mesh.nome_mesh)}</td><td><code>${esc(mesh.percorso_nodo)}</code></td><td>${esc(mesh.materiale_base || '—')}</td>
      ${['Materiale', 'Visibilità'].map((role) => `<td><select data-mesh-map="${role}" aria-label="${role} per ${esc(mesh.nome_mesh)}"><option value="">— nessuno —</option>${attributesForRole(role).map((pa) => `<option value="${pa.id_attributo}" ${String(meshMappingsById[meshMappingKey(mesh.id_mesh, role)] || '') === String(pa.id_attributo) ? 'selected' : ''}>${esc(attributeLabel(pa.attributi))}</option>`).join('')}</select></td>`).join('')}
      <td><button class="small ghost" type="button" data-highlight-mesh="${esc(mesh.percorso_nodo)}">Evidenzia</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Nessuna mesh nel GLB di questa misura.</p>';
  const meshMappingSection = () => {
    const selectedId = previewMeasures[0]?.previewId ?? '';
    const rows = selectedId ? meshesForMeasure(selectedId) : [];
    return `<label for="mapping-measure">Misura / GLB</label>
      <select id="mapping-measure">${previewMeasures.map((measure) => `<option value="${measure.previewId}">${esc(measure.dim_x)} × ${esc(measure.dim_y)} × ${esc(measure.dim_z)} ${esc(measure.unita_misura)} · ${esc(measure.risorse_glb.nome_file)}</option>`).join('')}</select>
      <div id="mesh-map-rows">${previewMeasures.length ? meshMappingRows(rows) : '<p class="empty">Associa prima un GLB a una misura.</p>'}</div>`;
  };
  const previewAttributesMarkup = (measureId, rules = []) => {
    const attributeIds = rules.length ? assegnati.map((attribute) => attribute.id_attributo) : mappedAttributeIds(measureId);
    if (!attributeIds.length) return '<p class="muted">Nessun attributo mappato su questo GLB.</p>';
    return attributeIds.map((attributeId) => {
      const attribute = assegnati.find((item) => item.id_attributo === attributeId);
      if (!attribute) return '';
      const block = $(`.attr-block[data-attr="${attributeId}"]`);
      const allowedIds = new Set(block
        ? $$('[data-opt]:checked', block).map((option) => Number(option.dataset.opt))
        : configs.filter((config) => config.id_attributo === attributeId).map((config) => config.id_opzione));
      const options = (previewOptionsByAttr[attributeId] || []).filter((option) => allowedIds.has(option.id_opzione));
      if (rules.length && !options.length) return '';
      return `<div class="field preview-attr-row"><label for="preview-attr-${attributeId}">${esc(attribute.attributi.nome)}${attribute.attributi.descrizione ? `: ${esc(attribute.attributi.descrizione)}` : ''}</label>
        <select id="preview-attr-${attributeId}" data-preview-attribute="${attributeId}" data-condition-attribute="${attributeId}">
          ${rules.length ? '' : '<option value="">— seleziona —</option>'}${options.map((option) => `<option value="${option.id_opzione}" ${String(option.id_opzione) === String(attribute.id_opzione_default || '') ? 'selected' : ''}>${esc(optionLabel(option))}</option>`).join('')}
        </select></div>`;
    }).join('');
  };
  const summaryMeasuresMarkup = () => {
    const rows = $$('#misure tr').filter((row) => row.dataset.misura !== 'new' || row.querySelector('[data-f=dim_x]').value || row.dataset.glb);
    return rows.length ? rows.map((row) => {
      const dimension = ['dim_x', 'dim_y', 'dim_z'].map((name) => row.querySelector(`[data-f=${name}]`).value || '—').join(' × ');
      const unit = row.querySelector('[data-f=unita_misura]').value;
      const glbName = row.querySelector('[data-glb-name]').value || 'Nessun GLB';
      return `<li><strong>${esc(dimension)} ${esc(unit)}</strong><span class="muted">${esc(glbName)}</span></li>`;
    }).join('') : '<li class="muted">Aggiungi una misura e associa un GLB.</li>';
  };
  const refreshProductSummary = () => {
    const measures = $('#product-summary-measures');
    if (measures) measures.innerHTML = summaryMeasuresMarkup();
  };

  shell(`
    <div class="page-head product-head"><a class="btn" href="#/prodotti">${btn('close', 'Chiudi')}</a></div>
    ${isNew ? `<form class="card" id="form-prodotto">
      <h2>Dati prodotto</h2>
      <div class="field"><label for="nome">Nome *</label><input id="nome" required maxlength="200" value="${esc(prodotto.nome)}"></div>
      <div class="field"><label for="descrizione">Descrizione</label><textarea id="descrizione">${esc(prodotto.descrizione)}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" id="attivo" ${prodotto.attivo ? 'checked' : ''}> Attivo nel catalogo</label></div>
    </form><p class="muted">Dopo la creazione potrai definire misure e attributi.</p>
    <div class="row"><div class="shrink"><button class="btn" type="button" id="new-attr-link">${btn('plus', 'Salva e definisci nuovo attributo')}</button></div></div>` : `
    <div class="product-editor-layout"><div class="product-editor-fields">
    <form class="card" id="form-prodotto">
      <h2>Dati prodotto</h2>
      <div class="field"><label for="nome">Nome *</label><input id="nome" required maxlength="200" value="${esc(prodotto.nome)}"></div>
      <div class="field"><label for="descrizione">Descrizione</label><textarea id="descrizione">${esc(prodotto.descrizione)}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" id="attivo" ${prodotto.attivo ? 'checked' : ''}> Attivo nel catalogo</label></div>
    </form>
    <section class="card"><h2>Misure e GLB (terne larghezza / altezza / profondità)</h2>
      <p class="muted">Ogni terna può avere un GLB indipendente, con mesh e mappatura attributi proprie.</p>
      <div class="table-scroll"><table><thead><tr><th>Larghezza</th><th>Altezza</th><th>Profondità</th><th>Unità</th><th>GLB oggetto</th><th></th></tr></thead>
      <tbody id="misure">${misure.map(misuraRow).join('')}${misuraRow(null)}</tbody></table></div>
      <button class="add-row" type="button" id="add-misura">${btn('plus', 'Aggiungi misura')}</button></section>
    <section class="card"><h2>Attributi del prodotto</h2>
      <div id="attr-blocks">${assegnati.map(attrBlock).join('')}</div>
      <p class="muted" id="no-attr" ${assegnati.length ? 'hidden' : ''}>Nessun attributo assegnato.</p>
      <div class="row"><div><label for="nuovo-attr">Aggiungi attributo esistente</label><select id="nuovo-attr">
        <option value="">— seleziona —</option>${assegnabili.map((a) => `<option value="${a.id_attributo}">${esc(attributeLabel(a))} (${esc(a.tipo_attributo)})</option>`).join('')}</select></div>
        <div class="shrink"><button class="btn" type="button" id="new-attr-link">${btn('plus', 'Definisci nuovo attributo')}</button></div>
        </div><p class="muted">Puoi aggiungerne quanti vuoi: tutto viene salvato con il pulsante in basso.</p></section>
    <section class="card"><h2>Condizioni tra attributi</h2>
      <p class="muted">Se un attributo ha il valore indicato, l'altro può assumere solo i valori selezionati. Senza una condizione sono ammesse tutte le opzioni del prodotto. Le condizioni contemporanee si applicano insieme.</p>
      <div id="condition-rules"></div>
      <button class="add-row" type="button" id="add-condition">${btn('plus', 'Aggiungi condizione')}</button></section>
    <section class="card"><h2>Mappatura mesh</h2>
      <p class="muted">Per ogni mesh puoi assegnare separatamente un attributo materiale e un attributo di visibilità. Ogni GLB ha la propria mappatura.</p>
      <p class="muted">Mesh selezionata: <code id="mapping-highlighted">nessuna</code></p>
      ${meshMappingSection()}</section></div>
    <aside class="card product-preview-panel">
      <div class="preview-fixed"><div class="preview-title"><h2>Anteprima di configurazione</h2>
        <button class="small" type="button" id="toggle-fullscreen" aria-pressed="false">${btn('expand', 'Schermo intero')}</button></div>
        <div class="product-preview-grid"><div><div class="product-preview-stage" id="productPreview"></div>
          <p class="preview-status muted" id="preview-status" role="status">${previewMeasures.length ? 'Caricamento del modello…' : 'Associa un GLB a una misura per avviare la preview.'}</p>
        </div></div></div>
      <div class="preview-scroll">
        <div class="field preview-measures"><h3>Misure</h3><label for="preview-measure">Modello per misura</label>
          <select id="preview-measure">${previewMeasures.map((measure) => `<option value="${measure.previewId}">${esc(measure.dim_x)} × ${esc(measure.dim_y)} × ${esc(measure.dim_z)} ${esc(measure.unita_misura)}</option>`).join('')}</select></div>
        <div class="preview-attributes"><h3>Attributi del GLB</h3><div id="preview-attributes">${previewMeasures.length ? previewAttributesMarkup(previewMeasures[0].previewId) : '<p class="muted">Gli attributi mappati compariranno qui.</p>'}</div></div>
      </div>
    </aside></div>`}
    ${saveBar(isNew ? 'Crea prodotto' : 'Salva tutto', isNew ? '' : `<button class="danger shrink" type="button" id="delete-product">${btn('trash', 'Elimina prodotto')}</button>`)}`,
    [['Prodotti', '#/prodotti'], [isNew ? 'Nuovo prodotto' : `Prodotto ${id}`]]);

  if (!isNew) refreshProductSummary();
  const originalMappings = { ...meshMappingsById };
  let createdId = null;
  const conditionAttributes = () => assegnati.map((pa) => {
    const block = $(`.attr-block[data-attr="${pa.id_attributo}"]`);
    const selected = new Set(block ? $$('[data-opt]:checked', block).map((input) => Number(input.dataset.opt)) : []);
    return {
      id: pa.id_attributo, nome: pa.attributi.nome, descrizione: pa.attributi.descrizione,
      defaultId: block ? num($('[data-f=default]', block).value) : null,
      options: (opzioniPerAttr[pa.id_attributo] || []).filter((option) => selected.has(option.id_opzione)),
    };
  });
  let redrawPreviewAttributes = () => {};
  let applyCurrentPreview = () => {};
  const conditionEditor = isNew ? null : createConditionEditor($('#condition-rules'), conditions, conditionAttributes, esc, () => {
    redrawPreviewAttributes();
    applyCurrentPreview();
  });
  if (conditionEditor) {
    conditionEditor.refresh();
    $('#add-condition').onclick = () => conditionEditor.add();
  }

  const saveProduct = async () => {
    const rec = { nome: $('#nome').value.trim(), descrizione: $('#descrizione').value.trim() || null, attivo: $('#attivo').checked };
    if (!rec.nome) throw new Error('Il nome è obbligatorio');
    if (isNew) {
      createdId = (await q(sb.from('prodotti').insert(rec).select('id_prodotto').single())).id_prodotto;
      return;
    }
    const rules = conditionEditor.getRules();
    const conditionedAttributes = conditionAttributes().filter((attribute) => attribute.options.length);
    if (!findConfiguration(conditionedAttributes, rules)) throw new Error('Le condizioni non permettono alcuna configurazione del prodotto.');

    const measureOps = $$('#misure tr').flatMap((tr) => {
      const mid = tr.dataset.misura;
      const rec = { dim_x: num($('[data-f=dim_x]', tr).value), dim_y: num($('[data-f=dim_y]', tr).value), dim_z: num($('[data-f=dim_z]', tr).value), unita_misura: $('[data-f=unita_misura]', tr).value, id_glb: num(tr.dataset.glb) };
      const dims = [rec.dim_x, rec.dim_y, rec.dim_z];
      if (mid === 'new' && dims.every((v) => v == null) && !rec.id_glb) return [];
      if (dims.some((v) => v == null || v <= 0)) throw new Error('Inserire tre dimensioni maggiori di zero per ogni misura');
      return [mid === 'new' ? () => q(sb.from('misure').insert({ ...rec, id_prodotto: id })) : () => q(sb.from('misure').update(rec).eq('id_misura', mid))];
    });

    const mappingChanges = [...new Set([...Object.keys(originalMappings), ...Object.keys(meshMappingsById)])]
      .filter((key) => (originalMappings[key] ?? null) !== (meshMappingsById[key] ?? null));
    const mappingRows = mappingChanges.filter((key) => meshMappingsById[key]).map((key) => {
      const [meshId, ruolo] = key.split(':');
      const attribute = assegnati.find((item) => String(item.id_attributo) === String(meshMappingsById[key]));
      if (!attribute) throw new Error('Un attributo mappato non è più assegnato al prodotto.');
      return { id_prodotto: id, id_mesh: Number(meshId), id_attributo: attribute.id_attributo, ruolo };
    });

    await q(sb.from('prodotti').update(rec).eq('id_prodotto', id));
    for (const op of measureOps) await op();

    const attributeRows = $$('.attr-block').map((block) => ({
      id_attributo: Number(block.dataset.attr),
      opzioni: $$('[data-opt]:checked', block).map((input) => Number(input.dataset.opt)),
      id_opzione_default: num($('[data-f=default]', block).value),
      ordine: num($('[data-f=ordine]', block).value) ?? 0,
      obbligatorio: $('[data-f=obbligatorio]', block).checked,
      codifica: $('[data-f=codifica]', block).checked,
    }));
    await q(sb.rpc('salva_attributi_condizioni', { prodotto_id: id, attributi: attributeRows, righe: rulesToRows(rules) }));

    if (mappingChanges.length) {
      for (const key of mappingChanges) {
        const [meshId, ruolo] = key.split(':');
        await q(sb.from('associazioni_mesh').delete().eq('id_prodotto', id).eq('id_mesh', meshId).eq('ruolo', ruolo));
      }
      if (mappingRows.length) await q(sb.from('associazioni_mesh').insert(mappingRows));
    }
  };
  const reload = () => viewProdotto(String(id ?? createdId));
  const saveAndGo = bindSaveAll(saveProduct, () => (isNew ? go(`#/prodotti/${createdId}`) : reload()));
  $('#new-attr-link').onclick = () => saveAndGo(() => withReturn('#/attributi/nuovo', `#/prodotti/${id ?? createdId}`));
  $('#form-prodotto').onsubmit = (e) => { e.preventDefault(); $('#save-all').click(); };
  if (isNew) return;

  $('#delete-product').onclick = async () => {
    if (!confirm(`Eliminare il prodotto "${prodotto.nome}" con misure, attributi e combinazioni collegate?`)) return;
    if (await act(() => q(sb.from('prodotti').delete().eq('id_prodotto', id)), 'Prodotto eliminato')) go('#/prodotti');
  };

  const previewPanel = $('.product-preview-panel');
  const fullscreenButton = $('#toggle-fullscreen');
  const setFullscreen = (on) => {
    previewPanel.classList.toggle('expanded', on);
    document.body.classList.toggle('no-scroll', on);
    fullscreenButton.setAttribute('aria-pressed', String(on));
    fullscreenButton.innerHTML = on ? btn('shrink', 'Torna alla vista precedente') : btn('expand', 'Schermo intero');
  };
  fullscreenButton.onclick = () => setFullscreen(!previewPanel.classList.contains('expanded'));
  const onEscape = (event) => {
    if (!previewPanel.isConnected) return document.removeEventListener('keydown', onEscape);
    if (event.key === 'Escape' && previewPanel.classList.contains('expanded')) setFullscreen(false);
  };
  document.addEventListener('keydown', onEscape);

  let refreshPreviewMeasures = () => {};
  let loadSelectedMeasure = async () => {};
  const uploadMeasureGlb = async (input) => {
    const file = input.files[0];
    if (!file) return;
    const tr = input.closest('tr');
    const status = $('[data-upload-status]', tr);
    input.disabled = true;
    status.textContent = 'Caricamento…';
    try {
      const resource = await uploadGlbResource(file, 'Oggetto', `${id}/oggetti/${tr.dataset.misura}`);
      tr.dataset.glb = resource.id_glb;
      $('[data-glb-name]', tr).value = file.name;
      status.textContent = 'Caricato: premi Salva tutto per associarlo';
      meshRows = meshRows.filter((mesh) => mesh.id_glb !== resource.id_glb).concat(resource.meshes || []);
      const previewId = tr.dataset.previewId;
      previewMeasures = previewMeasures.filter((measure) => measure.previewId !== previewId);
      previewMeasures.push({
        previewId,
        id_misura: previewId,
        id_glb: resource.id_glb,
        dim_x: $('[data-f=dim_x]', tr).value,
        dim_y: $('[data-f=dim_y]', tr).value,
        dim_z: $('[data-f=dim_z]', tr).value,
        unita_misura: $('[data-f=unita_misura]', tr).value,
        risorse_glb: { id_glb: resource.id_glb, nome_file: file.name, percorso_risorsa: resource.path },
      });
      refreshPreviewMeasures(previewId);
      refreshProductSummary();
      await loadSelectedMeasure();
    } catch (error) {
      status.textContent = '';
      toast(errMsg(error), true);
    }
    input.disabled = false;
    input.value = '';
  };

  $('#misure').addEventListener('change', (e) => {
    if (e.target.matches('[data-f=glb]')) uploadMeasureGlb(e.target);
  });

  $('#misure').onclick = async (e) => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    const tr = e.target.closest('tr');
    const mid = tr.dataset.misura;
    if (action === 'drop') {
      previewMeasures = previewMeasures.filter((measure) => measure.previewId !== tr.dataset.previewId);
      tr.remove();
      refreshPreviewMeasures();
      loadSelectedMeasure();
      refreshProductSummary();
      return;
    }
    if (action === 'clear-glb') {
      tr.dataset.glb = '';
      $('[data-glb-name]', tr).value = '';
      $('[data-upload-status]', tr).textContent = 'Rimosso: premi Salva tutto per confermare';
      previewMeasures = previewMeasures.filter((measure) => measure.previewId !== tr.dataset.previewId);
      refreshPreviewMeasures();
      loadSelectedMeasure();
      return;
    }
    if (action === 'del') {
      if (!confirm('Eliminare la misura e le combinazioni commerciali collegate?')) return;
      if (await act(() => q(sb.from('misure').delete().eq('id_misura', mid)), 'Misura eliminata')) {
        previewMeasures = previewMeasures.filter((measure) => measure.previewId !== tr.dataset.previewId);
        tr.remove();
        refreshPreviewMeasures();
        loadSelectedMeasure();
        refreshProductSummary();
      }
    }
  };
  $('#add-misura').onclick = () => {
    $('#misure').insertAdjacentHTML('beforeend', misuraRow(null));
    refreshProductSummary();
    $('#misure tr:last-child [data-f=dim_x]').focus();
  };
  const refreshMeasuresSummary = () => {
    refreshProductSummary();
    refreshPreviewMeasures();
  };
  $('#misure').addEventListener('input', refreshMeasuresSummary);
  $('#misure').addEventListener('change', refreshMeasuresSummary);

  let redrawMapping = () => {};
  const bindMeshMapping = () => {
    const selector = $('#mapping-measure');
    const container = $('#mesh-map-rows');
    if (!selector || !container) return;
    const draw = () => {
      const rows = meshesForMeasure(selector.value);
      container.innerHTML = meshMappingRows(rows);
    };
    container.addEventListener('change', (e) => {
      if (!e.target.matches('[data-mesh-map]')) return;
      const meshId = e.target.closest('[data-mesh-id]').dataset.meshId;
      const key = meshMappingKey(meshId, e.target.dataset.meshMap);
      const attributeId = num(e.target.value);
      if (attributeId) meshMappingsById[key] = attributeId;
      else delete meshMappingsById[key];
      $('#preview-status').textContent = 'Mappatura modificata: premi Salva tutto per confermare.';
      redrawPreviewAttributes();
      applyCurrentPreview();
    });
    container.addEventListener('click', (e) => {
      const button = e.target.closest('[data-highlight-mesh]');
      if (!button) return;
      container.querySelectorAll('[data-highlight-mesh]').forEach((item) => item.classList.toggle('selected', item === button));
      $('#mapping-highlighted').textContent = button.dataset.highlightMesh;
      const previewMeasure = $('#preview-measure');
      if (previewMeasure && previewMeasure.value !== selector.value) {
        previewMeasure.value = selector.value;
        previewMeasure.dispatchEvent(new Event('change'));
      } else {
        $('#productPreview').dispatchEvent(new CustomEvent('product-preview-highlight', { detail: { path: button.dataset.highlightMesh } }));
      }
    });
    selector.onchange = draw;
    redrawMapping = draw;
    draw();
  };
  bindMeshMapping();

  const attrSelect = $('#nuovo-attr');
  const bindAttrBlock = (block) => {
    const aid = Number(block.dataset.attr);
    // il default può essere scelto solo fra le opzioni spuntate
    block.addEventListener('change', (e) => {
      if (e.target.dataset.opt) {
        const def = $('[data-f=default]', block);
        const current = def.value;
        const checked = $$('[data-opt]:checked', block).map((c) => c.dataset.opt);
        def.innerHTML = '<option value="">— nessuno —</option>' + checked.map((v) => `<option value="${v}">${esc(e.target.closest('.opt-grid').querySelector(`[data-opt="${v}"]`).parentElement.textContent.trim())}</option>`).join('');
        def.value = checked.includes(current) ? current : '';
      }
      refreshProductSummary();
      conditionEditor.refresh();
      redrawPreviewAttributes();
      applyCurrentPreview();
    });
    block.onclick = async (e) => {
      if (!e.target.closest('[data-act=remove]')) return;
      const pending = block.dataset.new === '1';
      if (!pending && !confirm('Rimuovere l\'attributo dal prodotto (e le relative opzioni ammesse)?')) return;
      if (!pending && !(await act(() => q(sb.from('prodotti_attributi').delete().eq('id_prodotto', id).eq('id_attributo', aid)), 'Attributo rimosso'))) return;
      const index = assegnati.findIndex((item) => item.id_attributo === aid);
      const [removed] = assegnati.splice(index, 1);
      configs = configs.filter((c) => c.id_attributo !== aid);
      Object.keys(meshMappingsById).filter((key) => meshMappingsById[key] === aid).forEach((key) => { delete meshMappingsById[key]; delete originalMappings[key]; });
      attrSelect.add(new Option(`${removed.attributi.nome} (${removed.attributi.tipo_attributo})`, aid));
      block.remove();
      conditionEditor.refresh();
      $('#no-attr').hidden = assegnati.length > 0;
      redrawMapping();
      refreshProductSummary();
      redrawPreviewAttributes();
      applyCurrentPreview();
    };
  };
  $$('.attr-block').forEach(bindAttrBlock);

  attrSelect.onchange = async () => {
    const aid = num(attrSelect.value);
    if (!aid) return;
    attrSelect.disabled = true;
    try {
      const attribute = tuttiAttributi.find((a) => a.id_attributo === aid);
      const ao = await q(sb.from('attributi_opzioni').select('id_attributo, abilitata, opzioni(id_opzione, nome, descrizione, attiva, ordine, id_materiale, valore_visibilita, materiali(id_materiale, nome, id_glb, risorse_glb(percorso_risorsa)))').eq('id_attributo', aid));
      opzioniPerAttr[aid] = ao.filter((r) => r.abilitata && r.opzioni).map((r) => r.opzioni)
        .sort((a, b) => a.ordine - b.ordine || a.nome.localeCompare(b.nome));
      previewOptionsByAttr[aid] = opzioniPerAttr[aid];
      const orders = $$('#attr-blocks [data-f=ordine]').map((input) => Number(input.value) || 0);
      const pa = { id_attributo: aid, attributi: { nome: attribute.nome, descrizione: attribute.descrizione, tipo_attributo: attribute.tipo_attributo }, id_opzione_default: null, ordine: orders.length ? Math.max(...orders) + 1 : 0, obbligatorio: true, codifica: true, pending: true };
      assegnati.push(pa);
      $('#attr-blocks').insertAdjacentHTML('beforeend', attrBlock(pa));
      bindAttrBlock($('#attr-blocks').lastElementChild);
      conditionEditor.refresh();
      attrSelect.querySelector(`option[value="${aid}"]`).remove();
      $('#no-attr').hidden = true;
      redrawMapping();
      refreshProductSummary();
      redrawPreviewAttributes();
      applyCurrentPreview();
    } catch (error) {
      toast(errMsg(error), true);
    }
    attrSelect.value = '';
    attrSelect.disabled = false;
  };

  {
    const stage = $('#productPreview');
    const status = $('#preview-status');
    const measureSelect = $('#preview-measure');
    const signedUrls = new Map();
    let previewViewer = null;
    const signedUrlFor = async (path) => {
      const cached = signedUrls.get(path);
      if (cached && cached.expiresAt > Date.now()) return cached.url;
      try {
        const { data, error } = await sb.storage.from('modelli-glb').createSignedUrl(path, 300);
        if (error) throw error;
        signedUrls.set(path, { url: data.signedUrl, expiresAt: Date.now() + 4 * 60 * 1000 });
        return data.signedUrl;
      } catch (error) {
        signedUrls.delete(path);
        throw error;
      }
    };
    const optionFor = (attributeId) => {
      const optionId = $(`[data-preview-attribute="${attributeId}"]`)?.value;
      return (previewOptionsByAttr[attributeId] || []).find((option) => String(option.id_opzione) === optionId);
    };
    let previewSelection = null;
    let previewRules = [];
    let previewRulesError = '';
    let applyRevision = 0;
    const applyPreview = async () => {
      if (!previewViewer || previewToken !== productPreviewToken) return;
      const revision = ++applyRevision;
      if (previewRulesError) {
        status.textContent = previewRulesError;
        status.classList.add('error-text');
        return;
      }
      const messages = [];
      const entriesByPath = new Map();
      const measureId = measureSelect.value;
      for (const mesh of meshesForMeasure(measureId)) {
        const entry = { path: mesh.percorso_nodo };
        for (const role of ['Materiale', 'Visibilità']) {
          const attributeId = meshMappingsById[meshMappingKey(mesh.id_mesh, role)];
          if (!attributeId) continue;
          const option = optionFor(attributeId);
          if (!option) continue;
          const attribute = assegnati.find((item) => item.id_attributo === attributeId);
          if (role === 'Materiale') {
            if (!option.materiali?.id_glb || !option.materiali.risorse_glb?.percorso_risorsa) {
              messages.push(`${attribute.attributi.nome}: ${option.nome} non ha un GLB materiale associato.`);
              continue;
            }
            const url = await signedUrlFor(option.materiali.risorse_glb.percorso_risorsa);
            entry.material = await previewViewer.loadMaterial(option.id_materiale, url);
          } else if (option.valore_visibilita !== null) {
            entry.visible = option.valore_visibilita;
          }
        }
        entriesByPath.set(mesh.percorso_nodo, entry);
      }
      if (revision !== applyRevision || previewToken !== productPreviewToken) return;
      previewViewer.applyConfiguration([...entriesByPath.values()]);
      status.textContent = messages.length ? messages.join(' ') : 'Anteprima aggiornata.';
      status.classList.toggle('error-text', messages.length > 0);
    };
    const refreshPreviewAttributes = () => {
      const selectedOptions = new Map($$('[data-preview-attribute]', $('#preview-attributes'))
        .map((select) => [select.dataset.previewAttribute, select.value]));
      const selectedMeasure = previewMeasures.find((measure) => String(measure.previewId) === measureSelect.value);
      previewRulesError = '';
      try {
        previewRules = conditionEditor.getRules();
      } catch (error) {
        previewRules = [];
        previewRulesError = `Completa le condizioni per aggiornare l'anteprima: ${errMsg(error)}`;
      }
      $('#preview-attributes').innerHTML = selectedMeasure
        ? previewAttributesMarkup(selectedMeasure.previewId, previewRules)
        : '<p class="muted">Gli attributi mappati compariranno qui.</p>';
      $$('[data-preview-attribute]', $('#preview-attributes')).forEach((select) => {
        if (selectedOptions.has(select.dataset.previewAttribute)) select.value = selectedOptions.get(select.dataset.previewAttribute);
      });
      if (selectedMeasure && previewRules.length) {
        const attrs = conditionAttributes().filter((attribute) => attribute.options.length);
        previewSelection = updateConditionSelects($('#preview-attributes'), '[data-preview-attribute]', attrs, previewRules, previewSelection);
        if (!previewSelection) previewRulesError = 'Le condizioni non permettono alcuna configurazione.';
      } else {
        previewSelection = null;
      }
      if (previewRulesError) {
        status.textContent = previewRulesError;
        status.classList.add('error-text');
      }
      bindPreviewAttributes();
    };
    refreshPreviewMeasures = (preferredId = null) => {
      previewMeasures.forEach((measure) => {
        const row = $$('#misure tr').find((item) => item.dataset.previewId === String(measure.previewId));
        if (!row) return;
        measure.dim_x = $('[data-f=dim_x]', row).value;
        measure.dim_y = $('[data-f=dim_y]', row).value;
        measure.dim_z = $('[data-f=dim_z]', row).value;
        measure.unita_misura = $('[data-f=unita_misura]', row).value;
      });
      const options = previewMeasures.map((measure) => `<option value="${esc(measure.previewId)}">${esc(measure.dim_x)} × ${esc(measure.dim_y)} × ${esc(measure.dim_z)} ${esc(measure.unita_misura)}</option>`).join('');
      const mappingOptions = previewMeasures.map((measure) => `<option value="${esc(measure.previewId)}">${esc(measure.dim_x)} × ${esc(measure.dim_y)} × ${esc(measure.dim_z)} ${esc(measure.unita_misura)} · ${esc(measure.risorse_glb.nome_file)}</option>`).join('');
      const currentPreviewId = previewMeasures.some((measure) => String(measure.previewId) === measureSelect.value) ? measureSelect.value : null;
      const selectedId = preferredId || currentPreviewId || previewMeasures[0]?.previewId || '';
      const mappingSelect = $('#mapping-measure');
      const currentMappingId = previewMeasures.some((measure) => String(measure.previewId) === mappingSelect?.value) ? mappingSelect.value : null;
      measureSelect.innerHTML = options;
      measureSelect.value = String(selectedId);
      if (mappingSelect) {
        mappingSelect.innerHTML = mappingOptions;
        mappingSelect.value = String(preferredId || currentMappingId || selectedId);
        redrawMapping();
      }
      refreshPreviewAttributes();
      refreshProductSummary();
    };
    let loadRevision = 0;
    loadSelectedMeasure = async () => {
      const revision = ++loadRevision;
      const selectedMeasure = previewMeasures.find((measure) => String(measure.previewId) === measureSelect.value);
      if (!selectedMeasure) {
        status.textContent = 'Associa un GLB a una misura per avviare la preview.';
        measureSelect.disabled = false;
        previewViewer?.dispose();
        previewViewer = null;
        activeProductPreview = null;
        stage.replaceChildren();
        refreshPreviewAttributes();
        return;
      }
      applyRevision += 1;
      measureSelect.disabled = true;
      status.textContent = 'Caricamento del modello…';
      status.classList.remove('error-text');
      try {
        const url = await signedUrlFor(selectedMeasure.risorse_glb.percorso_risorsa);
        if (revision !== loadRevision || previewToken !== productPreviewToken) return;
        const { createProductPreview } = await import('./product-preview.js');
        if (revision !== loadRevision || previewToken !== productPreviewToken) return;
        if (!previewViewer) {
          previewViewer = createProductPreview(stage);
          activeProductPreview = previewViewer;
        }
        await previewViewer.loadProduct(url);
        if (revision !== loadRevision || previewToken !== productPreviewToken) return;
        refreshPreviewAttributes();
        previewViewer.highlight($('#mapping-highlighted').textContent === 'nessuna' ? null : $('#mapping-highlighted').textContent);
        await applyPreview();
      } catch (error) {
        if (revision !== loadRevision) return;
        status.textContent = `Impossibile caricare l’anteprima: ${errMsg(error)}`;
        status.classList.add('error-text');
      } finally {
        if (revision === loadRevision) measureSelect.disabled = false;
      }
    };
    const bindPreviewAttributes = () => {
      $$('[data-preview-attribute]', $('#preview-attributes')).forEach((select) => {
        select.onchange = () => {
          if (previewRules.length) {
            const attrs = conditionAttributes().filter((attribute) => attribute.options.length);
            previewSelection = updateConditionSelects($('#preview-attributes'), '[data-preview-attribute]', attrs, previewRules,
              previewSelection, Number(select.dataset.previewAttribute), Number(select.value));
            if (!previewSelection) {
              status.textContent = 'Nessuna configurazione compatibile con la selezione.';
              status.classList.add('error-text');
              return;
            }
          }
          applyPreview().catch((error) => {
            status.textContent = `Impossibile aggiornare l’anteprima: ${errMsg(error)}`;
            status.classList.add('error-text');
          });
        };
      });
    };
    redrawPreviewAttributes = refreshPreviewAttributes;
    applyCurrentPreview = () => applyPreview().catch((error) => {
      status.textContent = `Impossibile aggiornare l’anteprima: ${errMsg(error)}`;
      status.classList.add('error-text');
    });
    measureSelect.onchange = loadSelectedMeasure;
    stage.addEventListener('product-preview-highlight', (event) => {
      previewViewer?.highlight(event.detail.path);
    });
    bindPreviewAttributes();
    refreshPreviewMeasures();
    if (previewMeasures.length) loadSelectedMeasure();
  }
}

// ---------- attributi: elenco ----------
async function viewAttributi() {
  shell('<div class="empty">Caricamento…</div>', [['Attributi']]);
  const [attributi, usati] = await Promise.all([
    q(sb.from('attributi').select('*').order('nome')),
    qAll(() => sb.from('prodotti_attributi').select('id_attributo, id_prodotto').order('id_prodotto').order('id_attributo')),
  ]);
  const usedAttrs = new Set(usati.map((r) => r.id_attributo));
  const nome = (id) => attributi.find((a) => a.id_attributo === id)?.nome ?? '';

  const draw = (filter = '') => {
    const f = filter.toLowerCase();
    const rows = attributi.filter((a) => !f || `${a.nome} ${a.descrizione || ''}`.toLowerCase().includes(f));
    $('#rows').innerHTML = rows.length ? rows.map((a) => {
      return `<tr>
        <td><a href="#/attributi/${a.id_attributo}"><strong>${esc(a.nome)}</strong></a><div class="muted">${esc(a.descrizione)}</div></td>
        <td>${esc(a.tipo_attributo)}</td>
        <td>${a.id_attributo_padre ? `Derivato da <em>${esc(nome(a.id_attributo_padre))}</em>` : 'Generale'}</td>
        <td><span class="badge ${usedAttrs.has(a.id_attributo) ? 'ok' : 'no'}">${usedAttrs.has(a.id_attributo) ? 'Usato' : 'Non usato'}</span></td>
        <td><span class="badge ${a.attivo ? 'ok' : 'no'}">${a.attivo ? 'Attivo' : 'Non attivo'}</span></td>
        <td class="actions"><a class="btn small" href="#/attributi/${a.id_attributo}">${btn('pencil', 'Modifica')}</a> <button class="small danger" data-del="${a.id_attributo}">${btn('trash', 'Elimina')}</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">Nessun attributo.</td></tr>';
  };

  shell(`
    <div class="page-head"><div><h1>Attributi</h1><span class="muted">${attributi.length} attributi</span></div>
      <div class="row"><div class="search-wrap">${icon('search')}<input class="search" id="search" placeholder="Cerca…"></div><a class="btn primary shrink" href="#/attributi/nuovo">${btn('plus', 'Nuovo attributo')}</a></div></div>
    <div class="card table-scroll"><table><thead><tr><th>Attributo</th><th>Tipo</th><th>Origine</th><th>Utilizzo</th><th>Stato</th><th></th></tr></thead>
    <tbody id="rows"></tbody></table></div>`, [['Attributi']]);
  draw();
  $('#search').oninput = (e) => draw(e.target.value);
  $('#rows').onclick = async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    if (!confirm(`Eliminare l'attributo "${nome(Number(id))}" e tutte le sue opzioni?`)) return;
    if (await act(() => q(sb.from('attributi').delete().eq('id_attributo', id)), 'Attributo eliminato')) viewAttributi();
  };
}

// ---------- attributi: scheda ----------
async function viewAttributo(idParam, returnTo = '') {
  const isNew = idParam === 'nuovo';
  const id = isNew ? null : Number(idParam);
  const attrRoute = (attrId) => withReturn(`#/attributi/${attrId}`, returnTo);
  const crumbs = [[returnTo ? 'Torna alla pagina precedente' : 'Attributi', returnTo || '#/attributi'], [isNew ? 'Nuovo attributo' : `Attributo ${id}`]];
  shell('<div class="empty">Caricamento…</div>', crumbs);

  let attr = { nome: '', descrizione: '', tipo_attributo: 'Materiale', id_attributo_padre: null, attivo: true };
  let opzioni = [], materiali = [], generali = [], padreOpzioni = [], esposte = [];
  const usedOptions = new Set();
  const [mat, gen] = await Promise.all([
    q(sb.from('materiali').select('id_materiale, nome, descrizione').order('nome')),
    q(sb.from('attributi').select('id_attributo, nome, descrizione, tipo_attributo').is('id_attributo_padre', null).order('nome')),
  ]);
  materiali = mat; generali = gen;
  if (!isNew) {
    const a = await q(sb.from('attributi').select('*').eq('id_attributo', id).maybeSingle());
    if (!a) { toast('Attributo non trovato', true); return go('#/attributi'); }
    attr = a;
    if (attr.id_attributo_padre) {
      [padreOpzioni, esposte] = await Promise.all([
        q(sb.from('opzioni').select('id_opzione, nome, descrizione, attiva, ordine').eq('id_attributo', attr.id_attributo_padre).order('ordine').order('nome')),
        q(sb.from('attributi_opzioni').select('id_opzione, abilitata').eq('id_attributo', id)),
      ]);
    } else {
      opzioni = await q(sb.from('opzioni').select('*').eq('id_attributo', id).order('ordine').order('nome'));
      const optIds = opzioni.map((o) => o.id_opzione);
      if (optIds.length) {
        const [cfgUse, derUse] = await Promise.all([
          qAll(() => sb.from('configurazioni').select('id_opzione, id_prodotto').in('id_opzione', optIds).order('id_prodotto')),
          qAll(() => sb.from('attributi_opzioni').select('id_opzione, id_attributo').in('id_opzione', optIds).neq('id_attributo', id).order('id_attributo')),
        ]);
        [...cfgUse, ...derUse].forEach((r) => usedOptions.add(r.id_opzione));
      }
    }
  }
  const derivato = !!attr.id_attributo_padre;

  const effetto = (o) => attr.tipo_attributo === 'Materiale'
    ? `<select data-f="id_materiale"><option value="">— nessun materiale —</option>${materiali.map((m) => `<option value="${m.id_materiale}" ${o?.id_materiale === m.id_materiale ? 'selected' : ''}>${esc(m.descrizione ? `${m.nome} — ${m.descrizione}` : m.nome)}</option>`).join('')}</select>`
    : `<select data-f="valore_visibilita"><option value="">— non definito —</option><option value="true" ${o?.valore_visibilita === true ? 'selected' : ''}>Mostra</option><option value="false" ${o?.valore_visibilita === false ? 'selected' : ''}>Nascondi</option></select>`;

  const opzioneRow = (o, next = 0) => `<tr data-opz="${o?.id_opzione ?? 'new'}">
      <td style="width:9rem"><input data-f="nome" maxlength="10" value="${esc(o?.nome)}" placeholder="Nuova" aria-label="Nome"></td>
      <td><input data-f="descrizione" value="${esc(o?.descrizione)}" aria-label="Descrizione"></td>
      <td>${effetto(o)}</td>
      <td style="width:80px"><input type="number" data-f="ordine" value="${o ? o.ordine : next}" aria-label="Ordine"></td>
      <td><input type="checkbox" data-f="attiva" ${!o || o.attiva ? 'checked' : ''} aria-label="Attiva"></td>
      <td class="col-narrow">${o ? `<span class="badge ${usedOptions.has(o.id_opzione) ? 'ok' : 'no'}">${usedOptions.has(o.id_opzione) ? 'SI' : 'NO'}</span>` : ''}</td>
      <td class="actions">${o ? `<button class="small danger" type="button" data-act="del">${btn('trash', 'Elimina')}</button>` : `<button class="small ghost" type="button" data-act="drop">${btn('close', 'Annulla')}</button>`}</td></tr>`;

  const abilitate = new Set(esposte.filter((e) => e.abilitata).map((e) => e.id_opzione));
  const nextOrdine = opzioni.length ? Math.max(...opzioni.map((o) => o.ordine)) + 1 : 0;

  const opzioniSection = isNew ? '<p class="muted">Dopo la creazione potrai definire le opzioni.</p>' : derivato ? `
    <section class="card"><h2>Opzioni del derivato</h2>
      <p class="muted">Seleziona le opzioni dell'attributo padre da includere in questo attributo.</p>
      <div class="opt-grid">${padreOpzioni.map((o) => `<label class="check"><input type="checkbox" data-opt="${o.id_opzione}" ${abilitate.has(o.id_opzione) ? 'checked' : ''}> ${esc(optionLabel(o))}${o.attiva ? '' : ' <span class="muted">(non attiva)</span>'}</label>`).join('') || '<span class="muted">L\'attributo padre non ha opzioni.</span>'}</div>
</section>` : `
    <section class="card"><h2>Opzioni</h2>
      <div class="search-wrap" style="margin-bottom:.75rem">${icon('search')}<input class="search" id="opt-search" placeholder="Filtra opzioni…" aria-label="Filtra opzioni"></div>
      <div class="table-scroll"><table><thead><tr><th>Nome</th><th>Descrizione</th><th>${attr.tipo_attributo === 'Materiale' ? 'Materiale' : 'Visibilità'}</th><th>Ordine</th><th>Attiva</th><th class="col-narrow">Usata</th><th></th></tr></thead>
      <tbody id="opzioni">${opzioni.map((o) => opzioneRow(o)).join('')}${opzioneRow(null, nextOrdine)}</tbody></table></div>
      <div class="add-row row"><div class="shrink"><button type="button" id="add-option">${btn('plus', 'Aggiungi opzione')}</button></div>
      ${attr.tipo_attributo === 'Materiale' ? `<div class="shrink"><button class="btn" type="button" id="new-material-link">${btn('plus', 'Salva e definisci nuovo materiale')}</button></div>` : ''}</div>
    </section>`;

  shell(`
    <div class="page-head"><div><h1>${isNew ? 'Nuovo attributo' : esc(attr.nome)}</h1>
      <span class="muted">${derivato ? 'Attributo derivato' : 'Attributo generale'}</span></div><a class="btn" href="${returnTo || '#/attributi'}">${btn('close', returnTo ? 'Torna' : 'Chiudi')}</a></div>
    <form class="card" id="form-attr">
      <h2>Dati attributo</h2>
      <div class="row">
        <div class="field"><label for="nome">Nome *</label><input id="nome" required maxlength="150" value="${esc(attr.nome)}"></div>
        <div class="field"><label for="tipo">Tipo</label><select id="tipo" ${isNew ? '' : 'disabled'}>
          ${['Materiale', 'Visibilità'].map((t) => `<option ${attr.tipo_attributo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label for="padre">Deriva da</label><select id="padre" ${isNew ? '' : 'disabled'}>
          <option value="">— nessuno (attributo generale) —</option>
          ${generali.map((g) => `<option value="${g.id_attributo}" data-tipo="${esc(g.tipo_attributo)}" ${attr.id_attributo_padre === g.id_attributo ? 'selected' : ''}>${esc(attributeLabel(g))}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="descrizione">Descrizione</label><textarea id="descrizione">${esc(attr.descrizione)}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" id="attivo" ${attr.attivo ? 'checked' : ''}> Attivo</label></div>
    </form>${opzioniSection}${saveBar(isNew ? 'Crea attributo' : 'Salva tutto')}`, crumbs);

  // un derivato ha il tipo del padre
  $('#padre').onchange = () => {
    const t = $('#padre').selectedOptions[0].dataset.tipo;
    if (t) $('#tipo').value = t;
    $('#tipo').disabled = !!t || !isNew;
  };

  let createdId = null;
  const saveAttribute = async () => {
    const rec = { nome: $('#nome').value.trim(), descrizione: $('#descrizione').value.trim() || null, attivo: $('#attivo').checked };
    if (!rec.nome) throw new Error('Il nome è obbligatorio');
    if (isNew) {
      rec.tipo_attributo = $('#tipo').value;
      rec.id_attributo_padre = num($('#padre').value);
      createdId = (await q(sb.from('attributi').insert(rec).select('id_attributo').single())).id_attributo;
      return;
    }

    const optionOps = derivato ? [] : $$('#opzioni tr').flatMap((tr) => {
      const oid = tr.dataset.opz;
      const f = (n) => $(`[data-f=${n}]`, tr);
      const opt = { nome: f('nome').value.trim(), descrizione: f('descrizione').value.trim() || null, ordine: num(f('ordine').value) ?? 0, attiva: f('attiva').checked };
      if (oid === 'new' && !opt.nome && !f('descrizione').value.trim()) return [];
      if (!opt.nome) throw new Error('Il nome dell\'opzione è obbligatorio');
      if (attr.tipo_attributo === 'Materiale') opt.id_materiale = num(f('id_materiale').value);
      else opt.valore_visibilita = f('valore_visibilita').value === '' ? null : f('valore_visibilita').value === 'true';
      return [oid === 'new' ? () => q(sb.from('opzioni').insert({ ...opt, id_attributo: id })) : () => q(sb.from('opzioni').update(opt).eq('id_opzione', oid))];
    });

    await q(sb.from('attributi').update(rec).eq('id_attributo', id));
    for (const op of optionOps) await op();

    if (derivato) {
      const wanted = $$('[data-opt]:checked').map((c) => Number(c.dataset.opt));
      const known = new Set(esposte.map((x) => x.id_opzione));
      const toRemove = [...known].filter((o) => !wanted.includes(o));
      const toAdd = wanted.filter((o) => !known.has(o));
      if (toRemove.length) await q(sb.from('attributi_opzioni').delete().eq('id_attributo', id).in('id_opzione', toRemove));
      if (toAdd.length) await q(sb.from('attributi_opzioni').insert(toAdd.map((o) => ({ id_attributo: id, id_opzione: o }))));
    }
  };
  const reload = () => viewAttributo(String(id ?? createdId), returnTo);
  const saveAndGo = bindSaveAll(saveAttribute, () => (isNew ? go(attrRoute(createdId)) : reload()));
  $('#new-material-link')?.addEventListener('click', () => saveAndGo(withReturn('#/materiali/nuovo', location.hash)));
  $('#form-attr').onsubmit = (e) => { e.preventDefault(); $('#save-all').click(); };
  if (isNew || derivato) return;

  $('#opt-search').oninput = (e) => {
    const f = e.target.value.trim().toLowerCase();
    $$('#opzioni tr').forEach((tr) => {
      const text = ['nome', 'descrizione'].map((n) => $(`[data-f=${n}]`, tr).value).join(' ').toLowerCase();
      tr.hidden = !!f && (tr.dataset.opz === 'new' || !text.includes(f));
    });
  };
  $('#add-option').onclick = () => {
    const orders = $$('#opzioni [data-f=ordine]').map((input) => Number(input.value) || 0);
    $('#opzioni').insertAdjacentHTML('beforeend', opzioneRow(null, orders.length ? Math.max(...orders) + 1 : 0));
    $('#opzioni tr:last-child [data-f=nome]').focus();
  };
  $('#opzioni').onclick = async (e) => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    const tr = e.target.closest('tr');
    if (action === 'drop') { tr.remove(); return; }
    if (action !== 'del') return;
    if (!confirm('Eliminare l\'opzione? Verrà tolta anche da attributi derivati e prodotti che la usano.')) return;
    if (await act(() => q(sb.from('opzioni').delete().eq('id_opzione', tr.dataset.opz)), 'Opzione eliminata')) tr.remove();
  };
}

// ---------- materiali ----------
async function viewMateriali(idParam, returnTo = '') {
  const focusNew = idParam === 'nuovo';
  shell('<div class="empty">Caricamento…</div>', [['Materiali']]);
  const [materiali, risorse, usedRows] = await Promise.all([
    q(sb.from('materiali').select('*').order('nome')),
    q(sb.from('risorse_glb').select('id_glb, nome_file, percorso_risorsa').eq('tipo_risorsa', 'Materiale')),
    qAll(() => sb.from('opzioni').select('id_opzione, id_materiale').not('id_materiale', 'is', null).order('id_opzione')),
  ]);
  const resources = new Map(risorse.map((resource) => [String(resource.id_glb), resource]));
  const usedMaterials = new Set(usedRows.map((o) => String(o.id_materiale)));
  const usedBadge = (material) => (!material ? '' : usedMaterials.has(String(material.id_materiale)) ? '<span class="badge ok">Usato</span>' : '<span class="badge no">Non usato</span>');
  const materialRow = (material) => `<tr data-material="${material?.id_materiale ?? 'new'}" data-glb="${material?.id_glb ?? ''}">
    <td><input data-f="nome" maxlength="150" value="${esc(material?.nome)}" placeholder="${material ? 'Nome materiale' : 'Nuovo materiale: nome'}" aria-label="Nome materiale"></td>
    <td><input data-f="descrizione" value="${esc(material?.descrizione)}" placeholder="Descrizione" aria-label="Descrizione"></td>
    <td><div class="glb-field"><input data-glb-name readonly value="${esc(resources.get(String(material?.id_glb))?.nome_file)}" placeholder="Nessun GLB" aria-label="GLB del materiale">
      <label class="upload-button small btn">${icon('upload')}<span>Carica</span><input type="file" data-f="file" accept=".glb,model/gltf-binary" aria-label="Carica GLB materiale"></label></div>
      <span class="upload-status muted" data-upload-status></span></td>
    <td>${usedBadge(material)}</td>
    <td class="actions">${material ? `<button class="small danger" type="button" data-act="delete">${btn('trash', 'Elimina')}</button>` : `<button class="small ghost" type="button" data-act="drop">${btn('close', 'Annulla')}</button>`}</td></tr>`;

  shell(`
    <div class="page-head"><div><h1>Materiali</h1><span class="muted">${materiali.length} materiali · associa un GLB dedicato a ciascun materiale</span></div>
      <div class="row"><div class="search-wrap">${icon('search')}<input class="search" id="search" placeholder="Cerca…" aria-label="Filtra materiali"></div>
        ${returnTo ? `<a class="btn shrink" href="${returnTo}">${btn('close', 'Torna')}</a>` : ''}
        <button class="btn danger shrink" type="button" id="delete-all" ${materiali.length ? '' : 'disabled'}>${btn('trash', 'Elimina tutti')}</button>
        <button class="btn primary shrink" type="button" id="new-material">${btn('plus', 'Nuovo materiale')}</button></div></div>
    <div class="materials-layout">
    <section class="card table-scroll"><table><thead><tr><th>Nome</th><th>Descrizione</th><th>GLB</th><th>Utilizzo</th><th></th></tr></thead>
      <tbody id="materials">${materiali.map(materialRow).join('')}${materialRow(null)}</tbody></table></section>
    <aside class="card material-preview-panel"><h2>Anteprima GLB</h2>
      <div class="product-preview-stage" id="materialStage"></div><p class="preview-status muted" id="material-status" role="status">Seleziona un materiale.</p></aside>
    </div>
    <p class="muted">L'ultima riga vuota serve per creare un nuovo materiale. Il GLB viene archiviato in Supabase Storage; per sostituirlo carica un nuovo GLB. Eliminando un materiale viene eliminato anche il suo GLB e il riferimento sulle opzioni degli attributi viene svuotato.</p>
    ${saveBar()}`,
  [['Materiali']]);

  $('#search').oninput = (event) => {
    const f = event.target.value.trim().toLowerCase();
    $$('#materials tr').forEach((row) => {
      const text = ['nome', 'descrizione'].map((name) => $(`[data-f=${name}]`, row).value).join(' ').toLowerCase();
      row.hidden = !!f && (row.dataset.material === 'new' || !text.includes(f));
    });
  };

  // Elimina il record GLB e il file nello Storage.
  const removeGlbResources = async (ids) => {
    const list = ids.map((glbId) => resources.get(String(glbId))).filter(Boolean);
    if (!list.length) return;
    await q(sb.from('risorse_glb').delete().in('id_glb', list.map((r) => r.id_glb)));
    const { error } = await sb.storage.from('modelli-glb').remove(list.map((r) => r.percorso_risorsa));
    if (error) throw error;
    list.forEach((r) => resources.delete(String(r.id_glb)));
  };

  $('#delete-all').onclick = async () => {
    if (!confirm(`Eliminare TUTTI i ${materiali.length} materiali con i relativi GLB? I riferimenti sulle opzioni degli attributi verranno svuotati.`)) return;
    const glbIds = materiali.map((m) => m.id_glb).filter(Boolean);
    const ok = await act(async () => {
      await q(sb.from('materiali').delete().gt('id_materiale', 0));
      await removeGlbResources(glbIds);
    }, 'Materiali eliminati');
    if (ok) viewMateriali(idParam, returnTo);
  };

  const focusNewRow = (append) => {
    if (append) $('#materials').insertAdjacentHTML('beforeend', materialRow(null));
    const rowsNew = $$('#materials tr[data-material=new]');
    const newRow = rowsNew[rowsNew.length - 1];
    newRow.scrollIntoView({ block: 'center' });
    $('[data-f=nome]', newRow).focus();
  };
  $('#new-material').onclick = () => focusNewRow(true);
  if (focusNew) focusNewRow(false);

  const uploadMaterialGlb = async (input) => {
    const file = input.files[0];
    if (!file) return;
    const row = input.closest('tr');
    const materialId = row.dataset.material;
    const status = $('[data-upload-status]', row);
    input.disabled = true;
    status.textContent = 'Caricamento…';
    try {
      const uploaded = await uploadGlbResource(file, 'Materiale', `materiali/${materialId === 'new' ? crypto.randomUUID() : materialId}`);
      resources.set(String(uploaded.id_glb), { id_glb: uploaded.id_glb, nome_file: file.name, percorso_risorsa: uploaded.path });
      row.dataset.glb = uploaded.id_glb;
      $('[data-glb-name]', row).value = file.name;
      status.textContent = 'Caricato: premi Salva tutto per associarlo';
    } catch (error) {
      status.textContent = '';
      toast(errMsg(error), true);
    }
    input.disabled = false;
    input.value = '';
  };
  $('#materials').addEventListener('change', (event) => {
    if (event.target.matches('[data-f=file]')) uploadMaterialGlb(event.target).then(() => previewRow(event.target.closest('tr')));
  });

  let materialViewer = null;
  let selectedRow = null;
  let previewRevision = 0;
  const previewToken = ++productPreviewToken;
  activeProductPreview?.dispose();
  activeProductPreview = null;
  const previewStatus = $('#material-status');
  const previewRow = async (row) => {
    if (!row) return;
    selectedRow = row;
    $$('#materials tr.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    const revision = ++previewRevision;
    const resource = resources.get(String(row.dataset.glb));
    if (!resource) {
      previewStatus.textContent = 'Nessun GLB associato al materiale.';
      materialViewer?.clear();
      return;
    }
    previewStatus.textContent = 'Caricamento del modello…';
    try {
      const { data, error } = await sb.storage.from('modelli-glb').createSignedUrl(resource.percorso_risorsa, 300);
      if (error) throw error;
      if (revision !== previewRevision || previewToken !== productPreviewToken) return;
      if (!materialViewer) {
        const { createProductPreview } = await import('./product-preview.js');
        if (revision !== previewRevision || previewToken !== productPreviewToken) return;
        materialViewer = createProductPreview($('#materialStage'));
        activeProductPreview = materialViewer;
      }
      await materialViewer.loadProduct(data.signedUrl);
      if (revision === previewRevision && previewToken === productPreviewToken) previewStatus.textContent = resource.nome_file || '';
    } catch (error) {
      if (revision === previewRevision && previewToken === productPreviewToken) previewStatus.textContent = errMsg(error);
    }
  };
  $('#materials').addEventListener('focusin', (event) => {
    const row = event.target.closest('tr');
    if (row && row !== selectedRow) previewRow(row);
  });

  $('#materials').onclick = async (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (action === 'drop') { event.target.closest('tr').remove(); return; }
    if (action !== 'delete') return;
    const materialId = event.target.closest('tr').dataset.material;
    const material = materiali.find((item) => String(item.id_materiale) === materialId);
    if (!confirm(`Eliminare il materiale "${material.nome}" e il suo GLB? Le opzioni collegate resteranno senza materiale.`)) return;
    const done = await act(async () => {
      await q(sb.from('materiali').delete().eq('id_materiale', materialId));
      await removeGlbResources([material.id_glb]);
    }, 'Materiale eliminato');
    if (done) event.target.closest('tr').remove();
  };

  const saveMaterials = async () => {
    const ops = $$('#materials tr').flatMap((row) => {
      const materialId = row.dataset.material;
      const rec = {
        nome: $('[data-f=nome]', row).value.trim(),
        descrizione: $('[data-f=descrizione]', row).value.trim() || null,
        id_glb: num(row.dataset.glb),
      };
      if (materialId === 'new' && !rec.nome && !rec.descrizione && !rec.id_glb) return [];
      if (!rec.nome) throw new Error('Il nome del materiale è obbligatorio.');
      return [materialId === 'new' ? () => q(sb.from('materiali').insert(rec)) : () => q(sb.from('materiali').update(rec).eq('id_materiale', materialId))];
    });
    for (const op of ops) await op();
  };
  bindSaveAll(saveMaterials, () => (returnTo ? go(returnTo) : location.hash === '#/materiali/nuovo' ? go('#/materiali') : viewMateriali()));
}

// ---------- commerciale: utilità ----------
async function qAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const data = await q(make().range(from, from + 999));
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const measureLabel = (m) => `${m.dim_x} × ${m.dim_y} × ${m.dim_z} ${m.unita_misura}`;
const MAX_COMBINATIONS = 5000;

function productSelect(prodotti, selectedId, base) {
  return `<div class="field"><label for="sel-prodotto">Prodotto</label><select id="sel-prodotto">
    <option value="">— seleziona un prodotto —</option>${prodotti.map((p) => `<option value="${p.id_prodotto}" ${p.id_prodotto === selectedId ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></div>`;
}

// ---------- commerciale: codici, descrizioni e prezzi ----------
async function viewCodifica(idParam) {
  activeProductPreview?.dispose();
  activeProductPreview = null;
  const crumbs = [['Codifica e Pricing']];
  shell('<div class="empty">Caricamento…</div>', crumbs);
  const prodotti = await q(sb.from('prodotti').select('id_prodotto, nome').order('nome'));
  const id = idParam ? Number(idParam) : null;
  const head = (extra = '') => `<div class="page-head"><div><h1>Codifica e Pricing</h1><span class="muted">Combinazioni misure / attributi / opzioni con codice, descrizione commerciale e prezzo.</span></div></div>
    <section class="card"><div class="row">${productSelect(prodotti, id)}${extra}</div></section>`;
  const bindSelect = () => { $('#sel-prodotto').onchange = (e) => go(e.target.value ? `#/codifica/${e.target.value}` : '#/codifica'); };
  if (!id) {
    shell(`${head()}<p class="empty">Seleziona un prodotto per vedere le sue combinazioni.</p>`, crumbs);
    return bindSelect();
  }

  const [cfg, listini, existing, existingPrices] = await Promise.all([
    loadProductConfig(id),
    listiniWithDefault(),
    qAll(() => sb.from('codifica').select('id_codice, id_misura, chiave_combinazione, codice_articolo, descrizione_articolo').eq('id_prodotto', id).order('id_codice')),
    qAll(() => sb.from('prezzi').select('id_listino, id_codice, prezzo, codifica!inner(id_prodotto)').eq('codifica.id_prodotto', id).order('id_codice')),
  ]);
  if (!cfg) { toast('Prodotto non trovato', true); return go('#/codifica'); }
  const { misure, attributes, rules } = cfg;

  const codingAttributes = attributes.filter((attribute) => attribute.codifica);
  if (!misure.length) {
    shell(`${head()}<p class="empty">Il prodotto non ha misure: aggiungile nella scheda prodotto.</p>`, crumbs);
    return bindSelect();
  }
  const combinations = codingCombinations(attributes, rules, Math.floor(MAX_COMBINATIONS / misure.length));
  if (combinations.length * misure.length > MAX_COMBINATIONS) {
    shell(`${head()}<p class="empty">Il prodotto supera ${MAX_COMBINATIONS} combinazioni ammesse. Riduci le opzioni nella scheda prodotto.</p>`, crumbs);
    return bindSelect();
  }

  const byKey = new Map(existing.map((c) => [`${c.id_misura}|${c.chiave_combinazione}`, c]));
  const priceByCode = new Map();
  existingPrices.forEach((p) => priceByCode.set(`${p.id_listino}|${p.id_codice}`, p.prezzo == null ? '' : String(p.prezzo)));
  const optionByKey = new Map(codingAttributes.flatMap((a) => a.options.map((o) => [`${a.id}:${o.id_opzione}`, o])));

  const rows = [];
  for (const misura of misure) {
    for (const pairs of combinations) {
      const key = comboKey(pairs);
      const found = byKey.get(`${misura.id_misura}|${key}`);
      const prices = {};
      if (found) listini.forEach((l) => { prices[l.id_listino] = priceByCode.get(`${l.id_listino}|${found.id_codice}`) ?? ''; });
      else listini.forEach((l) => { prices[l.id_listino] = ''; });
      const row = { misura, key, pairs, existingId: found?.id_codice ?? null, codice: found?.codice_articolo ?? '', descr: found?.descrizione_articolo ?? '', prices };
      row.orig = JSON.stringify([row.codice, row.descr, row.prices]);
      row.text = `${measureLabel(misura)} ${pairs.map(([a, o]) => `${attributeLabel(codingAttributes.find((x) => x.id === a))} ${optionLabel(optionByKey.get(`${a}:${o}`))}`).join(' ')}`.toLowerCase();
      rows.push(row);
    }
  }

  let listinoId = listini[0].id_listino;
  let measureFilter = '';
  let textFilter = '';
  const MAX_SHOWN = 500;

  shell(`${head(`<div class="field"><label for="sel-listino">Listino</label><select id="sel-listino">${listini.map((l) => `<option value="${l.id_listino}">${esc(l.nome)} (${esc(l.valuta)})</option>`).join('')}</select></div>
      <div class="field shrink"><label>&nbsp;</label><button type="button" class="small" id="new-listino">+ Nuovo listino</button></div>`)}
    <section class="card">
      <div class="row filters"><div class="field"><label for="flt-misura">Misura</label><select id="flt-misura"><option value="">Tutte</option>${misure.map((m) => `<option value="${m.id_misura}">${esc(measureLabel(m))}</option>`).join('')}</select></div>
        <div class="field grow"><label for="flt-text">Cerca</label><input id="flt-text" class="search" placeholder="Attributo, opzione, misura…"></div></div>
      <p class="muted" id="combo-count"></p>
      <div class="table-scroll"><table class="coding-table"><thead><tr><th class="col-measure">Misura</th><th class="col-combination">Combinazione</th><th class="col-code">Codice commerciale</th><th class="col-descr">Descrizione commerciale</th><th class="col-price">Prezzo</th></tr></thead><tbody id="combos"></tbody></table></div>
    </section>${saveBar()}`, crumbs);
  bindSelect();

  const draw = () => {
    const visible = rows.map((r, i) => [r, i]).filter(([r]) => (!measureFilter || String(r.misura.id_misura) === measureFilter) && (!textFilter || r.text.includes(textFilter)));
    $('#combo-count').textContent = `${visible.length} combinazioni su ${rows.length}${visible.length > MAX_SHOWN ? ` (mostrate le prime ${MAX_SHOWN}: usa i filtri)` : ''}.`;
    $('#combos').innerHTML = visible.slice(0, MAX_SHOWN).map(([r, i]) => `<tr data-i="${i}">
      <td class="col-measure">${esc(measureLabel(r.misura))}</td>
      <td class="col-combination">${r.pairs.map(([a, o]) => {
        const attribute = codingAttributes.find((x) => x.id === a);
        const option = optionByKey.get(`${a}:${o}`);
        return `<div class="combo-attribute">${esc(attribute.nome)}${attribute.descrizione ? `: ${esc(attribute.descrizione)}` : ''} = ${esc(option.nome)}${option.descrizione ? `: ${esc(option.descrizione)}` : ''}</div>`;
      }).join('') || '<span class="muted">—</span>'}</td>
      <td class="col-code"><input data-f="codice" maxlength="100" value="${esc(r.codice)}" aria-label="Codice commerciale"></td>
      <td class="col-descr"><input data-f="descr" value="${esc(r.descr)}" aria-label="Descrizione commerciale"></td>
      <td class="col-price"><input data-f="prezzo" type="number" min="0" step="0.01" value="${esc(r.prices[listinoId])}" aria-label="Prezzo"></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Nessuna combinazione.</td></tr>';
  };
  draw();

  $('#combos').addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const row = rows[Number(e.target.closest('tr').dataset.i)];
    if (f === 'prezzo') row.prices[listinoId] = e.target.value;
    else row[f] = e.target.value;
  });
  $('#sel-listino').onchange = (e) => { listinoId = Number(e.target.value); draw(); };
  $('#flt-misura').onchange = (e) => { measureFilter = e.target.value; draw(); };
  $('#flt-text').oninput = (e) => { textFilter = e.target.value.trim().toLowerCase(); draw(); };
  $('#new-listino').onclick = async () => {
    const nome = prompt('Nome del nuovo listino:');
    if (!nome?.trim()) return;
    if (await act(() => q(sb.from('listini').insert({ nome: nome.trim(), valuta: 'EUR' })), 'Listino creato')) viewCodifica(String(id));
  };

  const chunks = (list, n = 200) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));
  const saveCodifica = async () => {
    const dirty = rows.filter((r) => JSON.stringify([r.codice, r.descr, r.prices]) !== r.orig);
    const hasData = (r) => r.codice.trim() || r.descr.trim() || Object.values(r.prices).some((p) => p !== '');
    for (const r of dirty) {
      for (const p of Object.values(r.prices)) {
        if (p !== '' && !(Number(p) >= 0)) throw new Error('Il prezzo deve essere un numero maggiore o uguale a zero.');
      }
    }
    const toInsert = dirty.filter((r) => !r.existingId && hasData(r));
    const toUpdate = dirty.filter((r) => r.existingId && hasData(r));
    const toDelete = dirty.filter((r) => r.existingId && !hasData(r));
    const fields = (r) => ({ codice_articolo: r.codice.trim() || null, descrizione_articolo: r.descr.trim() || null });

    if (toDelete.length) for (const part of chunks(toDelete.map((r) => r.existingId))) await q(sb.from('codifica').delete().in('id_codice', part));
    for (const r of toUpdate) await q(sb.from('codifica').update(fields(r)).eq('id_codice', r.existingId));
    for (const part of chunks(toInsert)) {
      const created = await q(sb.from('codifica').insert(part.map((r) => ({ id_prodotto: id, id_misura: r.misura.id_misura, chiave_combinazione: r.key, ...fields(r) }))).select('id_codice, id_misura, chiave_combinazione'));
      const idByKey = new Map(created.map((c) => [`${c.id_misura}|${c.chiave_combinazione}`, c.id_codice]));
      part.forEach((r) => { r.existingId = idByKey.get(`${r.misura.id_misura}|${r.key}`); });
      await q(sb.from('codifica_dettagli').insert(part.flatMap((r) => r.pairs.map(([a, o]) => ({ id_codice: r.existingId, id_attributo: a, id_opzione: o })))));
    }

    const upserts = [], deletes = [];
    dirty.filter((r) => r.existingId && hasData(r)).forEach((r) => {
      const orig = JSON.parse(r.orig)[2];
      listini.forEach((l) => {
        const now = r.prices[l.id_listino];
        if (now === (orig[l.id_listino] ?? '')) return;
        if (now === '') deletes.push({ l: l.id_listino, c: r.existingId });
        else upserts.push({ id_listino: l.id_listino, id_codice: r.existingId, prezzo: Number(now) });
      });
    });
    for (const part of chunks(upserts)) await q(sb.from('prezzi').upsert(part, { onConflict: 'id_listino,id_codice' }));
    for (const d of deletes) await q(sb.from('prezzi').delete().eq('id_listino', d.l).eq('id_codice', d.c));
  };
  bindSaveAll(saveCodifica, () => viewCodifica(String(id)));
}

// ---------- commerciale: test finale prodotto ----------
async function viewTest(idParam) {
  const token = ++productPreviewToken;
  activeProductPreview?.dispose();
  activeProductPreview = null;
  const crumbs = [['Final Check']];
  shell('<div class="empty">Caricamento…</div>', crumbs);
  const prodotti = await q(sb.from('prodotti').select('id_prodotto, nome, descrizione, validato').order('nome'));
  const id = idParam ? Number(idParam) : null;
  const picker = `<section class="card picker">
      <div class="picker-head"><h2 style="margin:0">Prodotti</h2>
        <div class="search-wrap">${icon('search')}<input class="search" id="pk-search" placeholder="Filtra o cerca…" aria-label="Filtra prodotti"></div></div>
      <div class="picker-list" id="pk-list" role="listbox"></div>
      <div class="picker-actions" id="pk-actions"></div></section>`;
  const drawPicker = (filter = '') => {
    const f = filter.trim().toLowerCase();
    const list = prodotti.filter((p) => !f || `${p.nome} ${p.descrizione || ''}`.toLowerCase().includes(f))
      .sort((a, b) => Number(a.validato) - Number(b.validato) || a.nome.localeCompare(b.nome));
    $('#pk-list').innerHTML = list.map((p) => `<a class="picker-item ${p.id_prodotto === id ? 'selected' : ''}" href="#/test/${p.id_prodotto}" role="option"><span>${esc(p.nome)}${p.descrizione ? ` : <span class="muted">${esc(p.descrizione)}</span>` : ''}</span>
      ${p.validato ? `<span class="badge ok">${icon('check')} Testato</span>` : '<span class="badge warn">Da validare</span>'}</a>`).join('') || '<div class="empty">Nessun prodotto.</div>';
    $('#pk-list .selected')?.scrollIntoView({ block: 'nearest' });
    const current = prodotti.find((p) => p.id_prodotto === id);
    $('#pk-actions').innerHTML = current ? (current.validato
      ? `<span class="badge ok">${icon('check')} Testato e pronto all'uso</span><button type="button" id="pk-toggle">Rimuovi il flag</button>`
      : `<button type="button" class="success" id="pk-toggle">${btn('seal', 'Segna come testato e pronto all\'uso')}</button>`) : '';
    const toggle = $('#pk-toggle');
    if (toggle) toggle.onclick = async () => {
      const next = !current.validato;
      toggle.disabled = true;
      const ok = await act(() => q(sb.from('prodotti').update({ validato: next, validato_il: next ? new Date().toISOString() : null }).eq('id_prodotto', id)), next ? 'Prodotto segnato come testato' : 'Flag rimosso');
      if (ok) current.validato = next;
      drawPicker($('#pk-search').value);
    };
  };
  const bindPicker = () => { drawPicker(); $('#pk-search').oninput = (e) => drawPicker(e.target.value); };
  const head = `<div class="page-head"><div><h1>Final Check</h1><span class="muted">Configura il prodotto e verifica codice, descrizione, prezzo e aspetto 3D.</span></div></div>`;
  const bindSelect = bindPicker;
  if (!id) {
    shell(`${head}${picker}<p class="empty">Seleziona un prodotto da provare.</p>`, crumbs);
    return bindSelect();
  }

  const [cfg, listini] = await Promise.all([loadProductConfig(id), listiniWithDefault()]);
  if (!cfg) { toast('Prodotto non trovato', true); return go('#/test'); }
  const { misure, attributes, rules } = cfg;
  const optionById = new Map(attributes.flatMap((a) => a.options.map((o) => [o.id_opzione, o])));

  shell(`${head}
    ${picker}
    <section class="card"><div class="row">
      <div class="field"><label for="t-misura">Misura</label><select id="t-misura">${misure.map((m) => `<option value="${m.id_misura}">${esc(measureLabel(m))}${m.id_glb ? '' : ' (senza GLB)'}</option>`).join('')}</select></div>
      <div class="field"><label for="t-listino">Listino</label><select id="t-listino">${listini.map((l) => `<option value="${l.id_listino}">${esc(l.nome)} (${esc(l.valuta)})</option>`).join('')}</select></div></div></section>
    <div class="test-layout">
      <div><div class="product-preview-stage test-stage" id="testStage"></div><p class="preview-status muted" id="t-status" role="status"></p></div>
      <aside>
        <section class="card"><h2>Configurazione</h2>
          ${attributes.map((a) => `<div class="field"><label for="t-attr-${a.id}">${esc(a.nome)}${a.descrizione ? ` : ${esc(a.descrizione)}` : ''}</label>
            <select id="t-attr-${a.id}" data-t-attr="${a.id}" data-condition-attribute="${a.id}">
            ${a.options.map((o) => `<option value="${o.id_opzione}" ${(a.defaultId ?? a.options[0].id_opzione) === o.id_opzione ? 'selected' : ''}>${esc(o.nome)}${o.descrizione ? ` : ${esc(o.descrizione)}` : ''}</option>`).join('')}</select></div>`).join('') || '<p class="muted">Nessun attributo configurabile.</p>'}
        </section>
        <section class="card result-card"><h2>Risultato</h2><div id="t-result" class="muted">…</div></section>
      </aside></div>`, crumbs);
  bindSelect();
  if (!misure.length) { $('#t-result').textContent = 'Il prodotto non ha misure.'; return; }

  const measureSelect = $('#t-misura');
  const status = $('#t-status');
  let selectedConfiguration = updateConditionSelects(app, '[data-t-attr]', attributes, rules);
  if (!selectedConfiguration) {
    $('#t-result').textContent = 'Le condizioni non permettono alcuna configurazione. Correggile nella scheda prodotto.';
    status.textContent = 'Anteprima non disponibile per questa configurazione.';
    $$('[data-t-attr]').forEach((select) => { select.disabled = true; });
    return;
  }
  const currentMeasure = () => misure.find((m) => String(m.id_misura) === measureSelect.value);
  const selection = () => attributes.map((a) => [a.id, Number($(`[data-t-attr="${a.id}"]`).value)]);
  const codeSelection = () => attributes.filter((a) => a.codifica)
    .map((a) => [a.id, Number($(`[data-t-attr="${a.id}"]`).value)]);

  // risultato commerciale
  let resultRevision = 0;
  const updateResult = async () => {
    const revision = ++resultRevision;
    const box = $('#t-result');
    const m = currentMeasure();
    const listino = listini.find((l) => String(l.id_listino) === $('#t-listino').value);
    try {
      const code = await q(sb.from('codifica').select('id_codice, codice_articolo, descrizione_articolo, attiva').eq('id_prodotto', id).eq('id_misura', m.id_misura).eq('chiave_combinazione', comboKey(codeSelection())).maybeSingle());
      let price = null;
      if (code) {
        const p = await q(sb.from('prezzi').select('prezzo').eq('id_listino', listino.id_listino).eq('id_codice', code.id_codice).maybeSingle());
        price = p?.prezzo ?? null;
      }
      if (revision !== resultRevision || token !== productPreviewToken) return;
      box.className = '';
      box.innerHTML = code ? `<dl class="result-list">
        <dt>Codice commerciale</dt><dd>${code.codice_articolo ? esc(code.codice_articolo) : '<span class="muted">non assegnato</span>'}</dd>
        <dt>Descrizione commerciale</dt><dd>${code.descrizione_articolo ? esc(code.descrizione_articolo) : '<span class="muted">non assegnata</span>'}</dd>
        <dt>Prezzo</dt><dd class="price">${price == null ? '<span class="muted">non definito</span>' : `${Number(price).toLocaleString('it-IT', { style: 'currency', currency: listino.valuta })}`}</dd>
        ${code.attiva ? '' : '<dt>Stato</dt><dd><span class="badge no">Combinazione non attiva</span></dd>'}</dl>`
        : '<p class="muted">Combinazione non codificata: assegna codice e prezzo in “Codifica e Pricing”.</p>';
    } catch (error) {
      if (revision === resultRevision) box.textContent = errMsg(error);
    }
  };

  // anteprima 3D
  const glbIds = [...new Set(misure.map((m) => m.id_glb).filter(Boolean))];
  let meshRows = [], mappings = {};
  if (glbIds.length) {
    const [meshes, assoc] = await Promise.all([
      q(sb.from('mesh_glb').select('id_mesh, id_glb, percorso_nodo').in('id_glb', glbIds)),
      q(sb.from('associazioni_mesh').select('id_mesh, id_attributo, ruolo').eq('id_prodotto', id)),
    ]);
    meshRows = meshes;
    assoc.forEach((a) => { mappings[`${a.id_mesh}:${a.ruolo}`] = a.id_attributo; });
  }
  const signedUrls = new Map();
  const signedUrlFor = async (path) => {
    const cached = signedUrls.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const { data, error } = await sb.storage.from('modelli-glb').createSignedUrl(path, 300);
    if (error) throw error;
    signedUrls.set(path, { url: data.signedUrl, expiresAt: Date.now() + 4 * 60 * 1000 });
    return data.signedUrl;
  };
  let viewer = null;
  let applyRevision = 0;
  const applyPreview = async () => {
    if (!viewer || token !== productPreviewToken) return;
    const revision = ++applyRevision;
    const m = currentMeasure();
    const chosen = new Map(selection());
    const messages = [];
    const entriesByPath = new Map();
    for (const mesh of meshRows.filter((x) => x.id_glb === m.id_glb)) {
      const entry = { path: mesh.percorso_nodo };
      for (const role of ['Materiale', 'Visibilità']) {
        const attributeId = mappings[`${mesh.id_mesh}:${role}`];
        const attribute = attributes.find((a) => a.id === attributeId);
        const option = attribute && optionById.get(chosen.get(attributeId));
        if (!option) continue;
        if (role === 'Materiale') {
          const path = option.materiali?.risorse_glb?.percorso_risorsa;
          if (!path) { messages.push(`${attribute.nome}: ${option.nome} non ha un GLB materiale.`); continue; }
          entry.material = await viewer.loadMaterial(option.id_materiale, await signedUrlFor(path));
        } else if (option.valore_visibilita !== null) {
          entry.visible = option.valore_visibilita;
        }
      }
      entriesByPath.set(mesh.percorso_nodo, entry);
    }
    if (revision !== applyRevision || token !== productPreviewToken) return;
    viewer.applyConfiguration([...entriesByPath.values()]);
    status.textContent = messages.join(' ');
    status.classList.toggle('error-text', messages.length > 0);
  };
  const guarded = (fn) => () => fn().catch((error) => {
    status.textContent = `Anteprima non disponibile: ${errMsg(error)}`;
    status.classList.add('error-text');
  });
  const loadMeasure = async () => {
    const m = currentMeasure();
    applyRevision += 1;
    status.classList.remove('error-text');
    if (!m.risorse_glb?.percorso_risorsa) {
      status.textContent = 'Questa misura non ha un GLB associato.';
      return;
    }
    status.textContent = 'Caricamento del modello…';
    const url = await signedUrlFor(m.risorse_glb.percorso_risorsa);
    if (token !== productPreviewToken) return;
    if (!viewer) {
      const { createProductPreview } = await import('./product-preview.js');
      if (token !== productPreviewToken) return;
      viewer = createProductPreview($('#testStage'));
      activeProductPreview = viewer;
    }
    await viewer.loadProduct(url);
    if (token !== productPreviewToken) return;
    status.textContent = '';
    await applyPreview();
  };

  const onConfigChange = (event) => {
    const id = Number(event.target.dataset.tAttr);
    selectedConfiguration = updateConditionSelects(app, '[data-t-attr]', attributes, rules, selectedConfiguration, id, Number(event.target.value));
    if (!selectedConfiguration) {
      status.textContent = 'Nessuna configurazione compatibile con la selezione.';
      return;
    }
    updateResult();
    guarded(applyPreview)();
  };
  $$('[data-t-attr]').forEach((s) => { s.onchange = onConfigChange; });
  $('#t-listino').onchange = updateResult;
  measureSelect.onchange = () => { updateResult(); guarded(loadMeasure)(); };
  updateResult();
  guarded(loadMeasure)();
}

// ---------- routing ----------
async function route() {
  if (!session) return viewLogin();
  const [routePath, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [a, b] = routePath.split('/');
  const returnTo = new URLSearchParams(query).get('return') || '';
  try {
    if (!a) return await viewMenu();
    if (a === 'prodotti') return b ? await viewProdotto(b) : await viewProdotti();
    if (a === 'attributi') return b ? await viewAttributo(b, returnTo) : await viewAttributi();
    if (a === 'materiali') return await viewMateriali(b, returnTo);
    if (a === 'codifica') return await viewCodifica(b);
    if (a === 'test') return await viewTest(b);
    go('#/');
  } catch (e) {
    toast(errMsg(e), true);
  }
}

window.addEventListener('hashchange', () => {
  productPreviewToken += 1;
  activeProductPreview?.dispose();
  activeProductPreview = null;
  route();
});
if (sb) {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((event, s) => {
    const changed = (s?.user?.id ?? null) !== (session?.user?.id ?? null);
    session = s;
    if (changed) { if (!s) go('#/'); route(); }
  });
}
route();
