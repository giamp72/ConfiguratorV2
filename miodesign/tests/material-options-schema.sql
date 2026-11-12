-- Run after schema.sql on a clean PostgreSQL database with Supabase roles.
begin;

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated, anon;
grant usage, select on all sequences in schema public to authenticated, anon;

set local role authenticated;
do $$
declare
  material_glb bigint; object_glb bigint; material_attr bigint; derived_attr bigint;
  visibility_attr bigint; material_option bigint; visibility_option bigint;
  product bigint; measure bigint; code bigint; price_list bigint;
begin
  insert into risorse_glb (nome_file, tipo_risorsa) values ('material.glb', 'Materiale') returning id_glb into material_glb;
  insert into risorse_glb (nome_file, tipo_risorsa) values ('object.glb', 'Oggetto') returning id_glb into object_glb;
  insert into attributi (nome, tipo_attributo) values ('Colore', 'Materiale') returning id_attributo into material_attr;
  insert into attributi (nome, tipo_attributo, id_attributo_padre) values ('Colore derivato', 'Materiale', material_attr) returning id_attributo into derived_attr;
  insert into attributi (nome, tipo_attributo) values ('Visibile', 'Visibilità') returning id_attributo into visibility_attr;
  insert into opzioni (id_attributo, nome, id_glb) values (material_attr, 'Rovere', material_glb) returning id_opzione into material_option;
  insert into opzioni (id_attributo, nome, valore_visibilita) values (visibility_attr, 'Sì', true) returning id_opzione into visibility_option;
  insert into attributi_opzioni (id_attributo, id_opzione) values (derived_attr, material_option);
  update risorse_glb set nome_file = 'renamed.glb' where id_glb = material_glb;
  begin
    update risorse_glb set tipo_risorsa = 'Oggetto' where id_glb = material_glb;
    raise exception 'Referenced material GLB accepted a different type';
  exception when foreign_key_violation then null;
  end;
  update opzioni set id_glb = null where id_opzione = material_option;
  update risorse_glb set tipo_risorsa = 'Oggetto' where id_glb = material_glb;
  update risorse_glb set tipo_risorsa = 'Materiale' where id_glb = material_glb;
  update opzioni set id_glb = material_glb where id_opzione = material_option;
  if not exists (select 1 from attributi_opzioni where id_attributo = derived_attr and id_opzione = material_option) then
    raise exception 'Derived option was not exposed';
  end if;

  begin
    insert into opzioni (id_attributo, nome, id_glb) values (visibility_attr, 'Invalid', material_glb);
    raise exception 'Visibility option accepted a material GLB';
  exception when raise_exception then
    if sqlerrm = 'Visibility option accepted a material GLB' then raise; end if;
  end;
  begin
    update opzioni set id_glb = object_glb where id_opzione = material_option;
    raise exception 'Material option accepted an object GLB';
  exception when raise_exception then
    if sqlerrm = 'Material option accepted an object GLB' then raise; end if;
  end;
  begin
    update opzioni set valore_visibilita = false where id_opzione = material_option;
    raise exception 'Material option accepted visibility';
  exception when raise_exception then
    if sqlerrm = 'Material option accepted visibility' then raise; end if;
  end;

  insert into prodotti (nome) values ('Prodotto') returning id_prodotto into product;
  insert into misure (id_prodotto, dim_x, dim_y, dim_z, id_glb) values (product, 1, 2, 3, object_glb) returning id_misura into measure;
  if to_regclass('public.componenti_misura') is not null then
    insert into componenti_misura (id_misura, id_prodotto, id_glb, nome) values (measure, product, object_glb, 'Componente');
    begin
      update risorse_glb set tipo_risorsa = 'Materiale' where id_glb = object_glb;
      raise exception 'Assembly GLB accepted a different type';
    exception when foreign_key_violation then null;
    end;
  end if;
  insert into prodotti_attributi (id_prodotto, id_attributo) values (product, derived_attr), (product, visibility_attr);
  insert into configurazioni (id_prodotto, id_attributo, id_opzione) values (product, derived_attr, material_option), (product, visibility_attr, visibility_option);
  insert into condizioni_attributi values (product, derived_attr, material_option, visibility_attr);
  insert into condizioni_attributi_valori values (product, derived_attr, material_option, visibility_attr, visibility_option);
  insert into codifica (id_prodotto, id_misura, chiave_combinazione) values (product, measure, 'test') returning id_codice into code;
  insert into codifica_dettagli values (code, derived_attr, material_option);
  insert into listini (nome) values ('Base') returning id_listino into price_list;
  insert into prezzi values (price_list, code, 0);
  if not exists (select 1 from prezzi where id_codice = code and prezzo = 0) then
    raise exception 'Zero price was not preserved';
  end if;

  delete from risorse_glb where id_glb = material_glb;
  if (select id_glb from opzioni where id_opzione = material_option) is not null then
    raise exception 'Deleting GLB did not clear the option reference';
  end if;
end $$;

set local role anon;
do $$
begin
  if exists (select 1 from opzioni) or exists (select 1 from risorse_glb) then
    raise exception 'Anonymous users can read protected tables';
  end if;
  begin
    insert into risorse_glb (nome_file, tipo_risorsa) values ('blocked.glb', 'Materiale');
    raise exception 'Anonymous users can insert protected rows';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
