-- Aggiornamento per database esistenti: eseguire nello SQL Editor di Supabase.
create table if not exists condizioni_attributi (
  id_prodotto bigint not null,
  id_attributo_origine bigint not null,
  id_opzione_origine bigint not null,
  id_attributo_destinazione bigint not null,
  primary key (id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione),
  check (id_attributo_origine <> id_attributo_destinazione),
  foreign key (id_prodotto, id_attributo_origine, id_opzione_origine)
    references configurazioni (id_prodotto, id_attributo, id_opzione) on delete cascade,
  foreign key (id_prodotto, id_attributo_destinazione)
    references prodotti_attributi (id_prodotto, id_attributo) on delete cascade
);
create table if not exists condizioni_attributi_valori (
  id_prodotto bigint not null,
  id_attributo_origine bigint not null,
  id_opzione_origine bigint not null,
  id_attributo_destinazione bigint not null,
  id_opzione_destinazione bigint not null,
  primary key (id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione, id_opzione_destinazione),
  foreign key (id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione)
    references condizioni_attributi (id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione) on delete cascade,
  foreign key (id_prodotto, id_attributo_destinazione, id_opzione_destinazione)
    references configurazioni (id_prodotto, id_attributo, id_opzione) on delete cascade
);
alter table condizioni_attributi enable row level security;
alter table condizioni_attributi_valori enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'condizioni_attributi' and policyname = 'autenticati') then
    create policy "autenticati" on condizioni_attributi for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'condizioni_attributi_valori' and policyname = 'autenticati') then
    create policy "autenticati" on condizioni_attributi_valori for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Opzioni e condizioni vengono aggiornate nella stessa transazione.
create or replace function salva_attributi_condizioni(prodotto_id bigint, attributi jsonb, righe jsonb)
returns void language plpgsql security invoker as $$
declare a record;
begin
  for a in select * from jsonb_to_recordset(attributi) as x(
    id_attributo bigint, opzioni jsonb, id_opzione_default bigint, ordine int, obbligatorio boolean, codifica boolean
  ) loop
    insert into prodotti_attributi (id_prodotto, id_attributo, ordine, obbligatorio, codifica)
    values (prodotto_id, a.id_attributo, a.ordine, a.obbligatorio, a.codifica)
    on conflict (id_prodotto, id_attributo) do update
      set ordine = excluded.ordine, obbligatorio = excluded.obbligatorio, codifica = excluded.codifica;
    delete from configurazioni c where c.id_prodotto = prodotto_id and c.id_attributo = a.id_attributo
      and not exists (select 1 from jsonb_array_elements_text(a.opzioni) v where v.value::bigint = c.id_opzione);
    insert into configurazioni (id_prodotto, id_attributo, id_opzione)
    select prodotto_id, a.id_attributo, value::bigint from jsonb_array_elements_text(a.opzioni)
    on conflict do nothing;
    update prodotti_attributi set id_opzione_default = a.id_opzione_default
    where id_prodotto = prodotto_id and id_attributo = a.id_attributo;
  end loop;
  delete from condizioni_attributi where id_prodotto = prodotto_id;
  insert into condizioni_attributi (
    id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione
  )
  select prodotto_id, r.id_attributo_origine, r.id_opzione_origine, r.id_attributo_destinazione
  from jsonb_to_recordset(righe) as r(
    id_attributo_origine bigint, id_opzione_origine bigint, id_attributo_destinazione bigint
  );
  insert into condizioni_attributi_valori (
    id_prodotto, id_attributo_origine, id_opzione_origine, id_attributo_destinazione, id_opzione_destinazione
  )
  select prodotto_id, r.id_attributo_origine, r.id_opzione_origine, r.id_attributo_destinazione, value::bigint
  from jsonb_to_recordset(righe) as r(
    id_attributo_origine bigint, id_opzione_origine bigint, id_attributo_destinazione bigint, valori jsonb
  ) cross join lateral jsonb_array_elements_text(r.valori);
end $$;
