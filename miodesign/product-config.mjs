import { rulesFromRows, validateRules } from './conditions.mjs';

export function createProductConfigRepository(sb, q, qAll) {
  const loadConditionRules = async (id) => {
    const [rows, values] = await Promise.all([
      qAll(() => sb.from('condizioni_attributi').select('*').eq('id_prodotto', id).order('id_attributo_origine').order('id_opzione_origine').order('id_attributo_destinazione')),
      qAll(() => sb.from('condizioni_attributi_valori').select('*').eq('id_prodotto', id).order('id_attributo_origine').order('id_opzione_origine').order('id_attributo_destinazione').order('id_opzione_destinazione')),
    ]);
    return rulesFromRows(rows, values);
  };
  const loadProductConfig = async (id) => {
    const [prodotto, misure, assegnati, configs, rules] = await Promise.all([
      q(sb.from('prodotti').select('*').eq('id_prodotto', id).maybeSingle()),
      q(sb.from('misure').select('*, risorse_glb(id_glb, nome_file, percorso_risorsa)').eq('id_prodotto', id).order('dim_x').order('dim_y').order('dim_z')),
      q(sb.from('prodotti_attributi').select('*, attributi(nome, descrizione, tipo_attributo)').eq('id_prodotto', id).order('ordine')),
      q(sb.from('configurazioni').select('id_attributo, id_opzione').eq('id_prodotto', id)),
      loadConditionRules(id),
    ]);
    if (!prodotto) return null;
    const attrIds = assegnati.map((a) => a.id_attributo);
    const optionsById = {};
    if (attrIds.length) {
      const ao = await q(sb.from('attributi_opzioni').select('id_attributo, abilitata, opzioni(id_opzione, nome, descrizione, attiva, ordine, id_materiale, valore_visibilita, materiali(id_materiale, nome, id_glb, risorse_glb(percorso_risorsa)))').in('id_attributo', attrIds));
      ao.filter((r) => r.abilitata && r.opzioni).forEach((r) => (optionsById[r.id_attributo] ||= []).push(r.opzioni));
    }
    const attributes = assegnati.map((pa) => {
      const allowed = new Set(configs.filter((c) => c.id_attributo === pa.id_attributo).map((c) => c.id_opzione));
      const options = (optionsById[pa.id_attributo] || []).filter((o) => allowed.has(o.id_opzione))
        .sort((a, b) => a.ordine - b.ordine || a.nome.localeCompare(b.nome));
      return { id: pa.id_attributo, nome: pa.attributi.nome, descrizione: pa.attributi.descrizione, tipo: pa.attributi.tipo_attributo, codifica: pa.codifica !== false, defaultId: pa.id_opzione_default, options };
    }).filter((a) => a.options.length);
    validateRules(attributes, rules);
    return { prodotto, misure, attributes, rules };
  };
  const listiniWithDefault = async () => {
    let listini = await q(sb.from('listini').select('*').eq('attivo', true).order('nome'));
    if (!listini.length) {
      await q(sb.from('listini').insert({ nome: 'Listino base', valuta: 'EUR' }));
      listini = await q(sb.from('listini').select('*').eq('attivo', true).order('nome'));
    }
    return listini;
  };
  return { loadConditionRules, loadProductConfig, listiniWithDefault };
}
