-- Run with psql -v ON_ERROR_STOP=1 after schema.sql and assembly.sql on a
-- clean test database. Requires a privileged user able to SET ROLE to
-- authenticated and anon; if anon is absent, creating it requires CREATEROLE.
-- All rows, grants and any newly created anon role roll back; sequence values
-- can still advance, so run only on a disposable database.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated, anon;
grant usage, select on all sequences in schema public to authenticated, anon;

create function pg_temp.must_fail(statement text, expected_state text) returns void
language plpgsql as $$
declare actual_state text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'Expected SQLSTATE %, got % for %', expected_state, actual_state, statement;
  end;
  raise exception 'Unexpected success: %', statement;
end $$;

set local role authenticated;
do $$
declare
  p1 bigint; p2 bigint; m1 bigint; m2 bigint; other_measure bigint;
  g1 bigint; g2 bigint; material_glb bigint; mesh1 bigint; mesh2 bigint;
  material1 bigint; material2 bigint; visibility bigint; unassigned bigint;
  c1 bigint; c2 bigint; c3 bigint; c4 bigint;
begin
  insert into prodotti (nome) values ('assembly-test-p1') returning id_prodotto into p1;
  insert into prodotti (nome) values ('assembly-test-p2') returning id_prodotto into p2;
  insert into misure (id_prodotto, dim_x, dim_y, dim_z, unita_misura)
    values (p1, 100, 100, 100, 'cm') returning id_misura into m1;
  insert into misure (id_prodotto, dim_x, dim_y, dim_z, unita_misura)
    values (p1, 2000, 1000, 1000, 'mm') returning id_misura into m2;
  insert into misure (id_prodotto, dim_x, dim_y, dim_z)
    values (p2, 3, 3, 3) returning id_misura into other_measure;
  insert into risorse_glb (nome_file, tipo_risorsa)
    values ('assembly-object-1.glb', 'Oggetto') returning id_glb into g1;
  insert into risorse_glb (nome_file, tipo_risorsa)
    values ('assembly-object-2.glb', 'Oggetto') returning id_glb into g2;
  insert into risorse_glb (nome_file, tipo_risorsa)
    values ('assembly-material.glb', 'Materiale') returning id_glb into material_glb;
  insert into mesh_glb (id_glb, nome_mesh, percorso_nodo)
    values (g1, 'Mesh 1', '/mesh1') returning id_mesh into mesh1;
  insert into mesh_glb (id_glb, nome_mesh, percorso_nodo)
    values (g2, 'Mesh 2', '/mesh2') returning id_mesh into mesh2;
  insert into attributi (nome, tipo_attributo)
    values ('Material 1', 'Materiale') returning id_attributo into material1;
  insert into attributi (nome, tipo_attributo)
    values ('Material 2', 'Materiale') returning id_attributo into material2;
  insert into attributi (nome, tipo_attributo)
    values ('Visibility', 'Visibilità') returning id_attributo into visibility;
  insert into attributi (nome, tipo_attributo)
    values ('Unassigned', 'Materiale') returning id_attributo into unassigned;
  insert into prodotti_attributi (id_prodotto, id_attributo)
    values (p1, material1), (p1, material2), (p1, visibility), (p2, unassigned);

  insert into componenti_misura
    (id_misura, id_prodotto, id_glb, nome, posizione_x, rotazione_y, ordine)
    values (m1, p1, g1, 'first instance', 0.25, 90, 1) returning id_componente into c1;
  insert into componenti_misura (id_misura, id_prodotto, id_glb, nome)
    values (m1, p1, g1, 'second instance') returning id_componente into c2;
  insert into componenti_misura (id_misura, id_prodotto, id_glb, nome)
    values (m1, p1, g1, 'negative tests') returning id_componente into c3;
  insert into componenti_misura (id_misura, id_prodotto, id_glb, nome)
    values (m2, p1, g1, 'other measure') returning id_componente into c4;
  if not exists (select 1 from componenti_misura where id_componente = c1
                 and posizione_x = 0.25 and posizione_y = 0 and rotazione_y = 90 and ordine = 1) then
    raise exception 'Component transform/defaults were not preserved';
  end if;

  insert into associazioni_mesh_componenti
    (id_componente, id_prodotto, id_glb, id_mesh, id_attributo, ruolo)
    values (c1, p1, g1, mesh1, material1, 'Materiale'),
           (c1, p1, g1, mesh1, visibility, 'Visibilità'),
           (c2, p1, g1, mesh1, material2, 'Materiale'),
           (c4, p1, g1, mesh1, material1, 'Materiale');
  insert into associazioni_mesh (id_prodotto, id_mesh, id_attributo, ruolo)
    values (p1, mesh1, material1, 'Materiale');

  perform pg_temp.must_fail(format(
    'insert into componenti_misura (id_misura,id_prodotto,id_glb,nome) values (%s,%s,%s,''bad'')', m1,p2,g1), '23503');
  perform pg_temp.must_fail(format(
    'insert into componenti_misura (id_misura,id_prodotto,id_glb,nome) values (%s,%s,%s,''bad'')', m1,p1,material_glb), '23503');
  perform pg_temp.must_fail(format(
    'insert into componenti_misura (id_misura,id_prodotto,id_glb,tipo_risorsa,nome) values (%s,%s,%s,''Materiale'',''bad'')', m1,p1,material_glb), '23514');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Materiale'')', c3,p2,g1,mesh1,unassigned), '23503');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Materiale'')', c3,p1,g2,mesh2,material1), '23503');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Materiale'')', c3,p1,g1,mesh2,material1), '23503');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Materiale'')', c3,p1,g1,mesh1,unassigned), '23503');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Visibilità'')', c3,p1,g1,mesh1,material1), '23503');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''invalid'')', c3,p1,g1,mesh1,material1), '23514');
  perform pg_temp.must_fail(format(
    'insert into associazioni_mesh_componenti (id_componente,id_prodotto,id_glb,id_mesh,id_attributo,ruolo) values (%s,%s,%s,%s,%s,''Materiale'')', c1,p1,g1,mesh1,material2), '23505');
  perform pg_temp.must_fail(format('update misure set id_prodotto=%s where id_misura=%s', p2,m1), '23503');
  perform pg_temp.must_fail(format('update componenti_misura set id_glb=%s where id_componente=%s', g2,c1), '23503');
  perform pg_temp.must_fail(format('update mesh_glb set id_glb=%s where id_mesh=%s', g2,mesh1), '23503');
  perform pg_temp.must_fail(format('update attributi set tipo_attributo=''Visibilità'' where id_attributo=%s', material1), '23503');
  perform pg_temp.must_fail(format('update risorse_glb set tipo_risorsa=''Materiale'' where id_glb=%s', g1), '23503');
  perform pg_temp.must_fail(format(
    'update associazioni_mesh_componenti set id_attributo=%s where id_componente=%s and ruolo=''Materiale''', unassigned,c1), '23503');

  delete from associazioni_mesh_componenti where id_componente = c1 and ruolo = 'Materiale';
  if not exists (select 1 from associazioni_mesh_componenti where id_componente = c2 and id_attributo = material2)
     or not exists (select 1 from associazioni_mesh_componenti where id_componente = c4 and id_attributo = material1)
     or not exists (select 1 from associazioni_mesh_componenti where id_componente = c1 and ruolo = 'Visibilità')
     or not exists (select 1 from associazioni_mesh where id_prodotto = p1 and id_mesh = mesh1) then
    raise exception 'Deleting one mapping affected another instance, role, measure or legacy association';
  end if;
  delete from prodotti_attributi where id_prodotto = p1 and id_attributo = material2;
  if exists (select 1 from associazioni_mesh_componenti where id_componente = c2)
     or not exists (select 1 from associazioni_mesh_componenti where id_componente = c4) then
    raise exception 'Product attribute deletion cascaded incorrectly';
  end if;
  delete from componenti_misura where id_componente = c1;
  if exists (select 1 from associazioni_mesh_componenti where id_componente = c1)
     or not exists (select 1 from associazioni_mesh_componenti where id_componente = c4) then
    raise exception 'Component deletion cascaded incorrectly';
  end if;
  delete from misure where id_misura = m2;
  if exists (select 1 from componenti_misura where id_componente = c4)
     or exists (select 1 from associazioni_mesh_componenti where id_componente = c4)
     or not exists (select 1 from componenti_misura where id_componente = c2) then
    raise exception 'Measure deletion cascaded incorrectly';
  end if;
  insert into associazioni_mesh_componenti
    (id_componente, id_prodotto, id_glb, id_mesh, id_attributo, ruolo)
    values (c2, p1, g1, mesh1, material1, 'Materiale');
  delete from mesh_glb where id_mesh = mesh1;
  if exists (select 1 from associazioni_mesh_componenti where id_componente = c2) then
    raise exception 'Mesh deletion did not cascade';
  end if;
  delete from prodotti where id_prodotto = p1;
  if exists (select 1 from componenti_misura where id_componente in (c2, c3)) then
    raise exception 'Product deletion did not cascade to components';
  end if;
  insert into componenti_misura (id_misura, id_prodotto, id_glb, nome)
    values (other_measure, p2, g1, 'assembly-rls');
  insert into mesh_glb (id_glb, nome_mesh, percorso_nodo)
    values (g1, 'RLS mesh', '/rls') returning id_mesh into mesh1;
  insert into associazioni_mesh_componenti
    (id_componente, id_prodotto, id_glb, id_mesh, id_attributo, ruolo)
    select id_componente, p2, g1, mesh1, unassigned, 'Materiale'
    from componenti_misura where nome = 'assembly-rls';
end $$;

-- Use non-owner roles with explicit privileges so these checks exercise RLS.
do $$
begin
  if (select count(*) from componenti_misura where nome = 'assembly-rls') <> 1
     or (select count(*) from associazioni_mesh_componenti) <> 1 then
    raise exception 'Authenticated role cannot read assembly data';
  end if;
  update componenti_misura set posizione_z = 1 where nome = 'assembly-rls';
  if not found then raise exception 'Authenticated role cannot update assembly data'; end if;
  update associazioni_mesh_componenti set ruolo = ruolo;
  if not found then raise exception 'Authenticated role cannot update assembly mappings'; end if;
end $$;

set local role anon;
do $$
declare affected integer;
begin
  if exists (select 1 from componenti_misura) or exists (select 1 from associazioni_mesh_componenti) then
    raise exception 'Anonymous role can read assembly data';
  end if;
  update componenti_misura set nome = 'forbidden';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Anonymous role can update assembly data'; end if;
  update associazioni_mesh_componenti set ruolo = ruolo;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Anonymous role can update assembly mappings'; end if;
  delete from componenti_misura;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Anonymous role can delete components'; end if;
  delete from associazioni_mesh_componenti;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Anonymous role can delete assembly mappings'; end if;
  begin
    insert into componenti_misura (id_misura, id_prodotto, id_glb, nome) values (1, 1, 1, 'forbidden');
    raise exception 'Anonymous role can insert components';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into associazioni_mesh_componenti (id_componente, id_prodotto, id_glb, id_mesh, id_attributo, ruolo)
      values (1, 1, 1, 1, 1, 'Materiale');
    raise exception 'Anonymous role can insert mappings';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
