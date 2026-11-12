-- MIODesign — schema database (Supabase / PostgreSQL 15+)
-- Schema per una nuova installazione.
-- Eseguire per intero nello SQL Editor di Supabase.
-- Convenzioni: nomi in snake_case; chiavi BIGINT; tutte le tabelle protette da RLS
-- (accesso consentito solo agli utenti autenticati).

-- =========================================================================
-- Archivio risorse GLB
-- =========================================================================
create table risorse_glb (
  id_glb            bigint generated always as identity primary key,
  nome_file         varchar(250) not null,
  percorso_risorsa  text,
  tipo_risorsa      varchar(20) not null check (tipo_risorsa in ('Oggetto', 'Materiale')),
  impronta_file     varchar(64),
  caricato_il       timestamptz not null default now(),
  unique (id_glb, tipo_risorsa)
);

-- =========================================================================
-- Attributi e opzioni
-- =========================================================================
create table attributi (
  id_attributo        bigint generated always as identity primary key,
  nome                varchar(150) not null,
  descrizione         text,
  id_attributo_padre  bigint references attributi (id_attributo) on delete restrict,
  tipo_attributo      varchar(20) not null check (tipo_attributo in ('Materiale', 'Visibilità')),
  attivo              boolean not null default true
);

create table opzioni (
  id_opzione        bigint generated always as identity primary key,
  id_attributo      bigint not null references attributi (id_attributo) on delete cascade,
  nome              varchar(150) not null,
  descrizione       text,
  id_glb            bigint,
  tipo_glb          varchar(20) not null default 'Materiale' check (tipo_glb = 'Materiale'),
  valore_visibilita boolean,
  ordine            int not null default 0,
  attiva            boolean not null default true,
  foreign key (id_glb, tipo_glb) references risorse_glb (id_glb, tipo_risorsa)
    on delete set null (id_glb)
);
create index opzioni_attributo_idx on opzioni (id_attributo);
create index opzioni_glb_idx on opzioni (id_glb, tipo_glb);

-- Opzioni esposte da ogni attributo: generale (proprie opzioni, popolata da trigger)
-- oppure derivato (sottoinsieme delle opzioni del padre).
create table attributi_opzioni (
  id_attributo bigint not null references attributi (id_attributo) on delete cascade,
  id_opzione   bigint not null references opzioni (id_opzione) on delete cascade,
  ordine       int,
  abilitata    boolean not null default true,
  primary key (id_attributo, id_opzione)
);
create index attributi_opzioni_opzione_idx on attributi_opzioni (id_opzione);

-- =========================================================================
-- Prodotti, misure, configurazioni
-- =========================================================================
create table prodotti (
  id_prodotto bigint generated always as identity primary key,
  nome        varchar(200) not null,
  descrizione text,
  attivo      boolean not null default true,
  validato    boolean not null default false,
  validato_il timestamptz,
  creato_il   timestamptz not null default now()
);

create table misure (
  id_misura    bigint generated always as identity primary key,
  id_prodotto  bigint not null references prodotti (id_prodotto) on delete cascade,
  dim_x        numeric(12,3) not null,
  dim_y        numeric(12,3) not null,
  dim_z        numeric(12,3) not null,
  unita_misura varchar(10) not null default 'cm',
  id_glb       bigint references risorse_glb (id_glb),
  unique (id_prodotto, dim_x, dim_y, dim_z)
);

create table prodotti_attributi (
  id_prodotto        bigint not null references prodotti (id_prodotto) on delete cascade,
  id_attributo       bigint not null references attributi (id_attributo) on delete restrict,
  id_opzione_default bigint,
  ordine             int not null default 0,
  obbligatorio       boolean not null default true,
  codifica           boolean not null default true,
  primary key (id_prodotto, id_attributo)
);

create table configurazioni (
  id_prodotto  bigint not null,
  id_attributo bigint not null,
  id_opzione   bigint not null,
  primary key (id_prodotto, id_attributo, id_opzione),
  foreign key (id_prodotto, id_attributo)
    references prodotti_attributi (id_prodotto, id_attributo) on delete cascade,
  foreign key (id_attributo, id_opzione)
    references attributi_opzioni (id_attributo, id_opzione) on delete cascade
);

-- Il default deve essere tra le opzioni ammesse; se l'opzione viene tolta il default si azzera.
alter table prodotti_attributi
  add constraint prodotti_attributi_default_fk
  foreign key (id_prodotto, id_attributo, id_opzione_default)
  references configurazioni (id_prodotto, id_attributo, id_opzione)
  on delete set null (id_opzione_default);

-- =========================================================================
-- Mesh e associazioni
-- =========================================================================
create table mesh_glb (
  id_mesh          bigint generated always as identity primary key,
  id_glb           bigint not null references risorse_glb (id_glb) on delete cascade,
  nome_mesh        varchar(200) not null,
  percorso_nodo    varchar(500) not null,
  indice_mesh      int,
  materiale_base   varchar(200),
  unique (id_glb, percorso_nodo)
);

create table associazioni_mesh (
  id_associazione bigint generated always as identity primary key,
  id_prodotto     bigint not null references prodotti (id_prodotto) on delete cascade,
  id_mesh         bigint not null references mesh_glb (id_mesh) on delete cascade,
  id_attributo    bigint not null references attributi (id_attributo) on delete restrict,
  ruolo           varchar(20) not null check (ruolo in ('Materiale', 'Visibilità')),
  unique (id_prodotto, id_mesh, ruolo),
  foreign key (id_prodotto, id_attributo)
    references prodotti_attributi (id_prodotto, id_attributo) on delete cascade
);

-- =========================================================================
-- Commercio
-- =========================================================================
create table listini (
  id_listino        bigint generated always as identity primary key,
  nome              varchar(150) not null,
  descrizione_listino text,
  valuta            char(3) not null default 'EUR',
  attivo            boolean not null default true
);

create table codifica (
  id_codice            bigint generated always as identity primary key,
  id_prodotto          bigint not null references prodotti (id_prodotto) on delete cascade,
  id_misura            bigint not null references misure (id_misura) on delete cascade,
  chiave_combinazione  varchar(250) not null,
  codice_articolo      varchar(100),            -- NON univoco
  descrizione_articolo text,
  attiva               boolean not null default true,
  unique (id_prodotto, id_misura, chiave_combinazione)
);

create table codifica_dettagli (
  id_codice    bigint not null references codifica (id_codice) on delete cascade,
  id_attributo bigint not null references attributi (id_attributo),
  id_opzione   bigint not null references opzioni (id_opzione),
  primary key (id_codice, id_attributo)
);

create table prezzi (
  id_listino bigint not null references listini (id_listino) on delete cascade,
  id_codice  bigint not null references codifica (id_codice) on delete cascade,
  prezzo     numeric(18,2),                      -- 0 è un prezzo, NULL è assenza di prezzo
  primary key (id_listino, id_codice)
);

-- =========================================================================
-- Pubblicazione
-- =========================================================================
create table versioni_prodotto (
  id_versione         bigint generated always as identity primary key,
  id_prodotto         bigint not null references prodotti (id_prodotto) on delete cascade,
  numero_versione     int not null,
  pubblicata_il       timestamptz not null default now(),
  stato               varchar(20) not null default 'Pubblicata' check (stato in ('Pubblicata', 'Ritirata')),
  snapshot_pubblicato jsonb,
  unique (id_prodotto, numero_versione)
);

-- =========================================================================
-- Regole di integrità (trigger)
-- =========================================================================

-- Un attributo derivato: padre generale (un solo livello) e stesso tipo del padre.
create function trg_attributi_check() returns trigger language plpgsql as $$
declare p attributi%rowtype;
begin
  if new.id_attributo_padre is not null then
    select * into p from attributi where id_attributo = new.id_attributo_padre;
    if p.id_attributo_padre is not null then
      raise exception 'Il padre di un attributo derivato deve essere un attributo generale';
    end if;
    if p.tipo_attributo <> new.tipo_attributo then
      raise exception 'Il tipo dell''attributo derivato deve coincidere con quello del padre (%)', p.tipo_attributo;
    end if;
    if tg_op = 'UPDATE' and new.id_attributo = new.id_attributo_padre then
      raise exception 'Un attributo non può derivare da se stesso';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.tipo_attributo <> old.tipo_attributo
     and exists (select 1 from opzioni where id_attributo = new.id_attributo) then
    raise exception 'Impossibile cambiare il tipo di un attributo che ha già opzioni';
  end if;
  return new;
end $$;
create trigger attributi_check before insert or update on attributi
  for each row execute function trg_attributi_check();

-- Coerenza opzione/tipo: Materiale → solo GLB materiale; Visibilità → solo valore_visibilita.
create function trg_opzioni_check() returns trigger language plpgsql as $$
declare t text;
begin
  select tipo_attributo into t from attributi where id_attributo = new.id_attributo;
  if t = 'Materiale' and new.valore_visibilita is not null then
    raise exception 'Un''opzione di tipo Materiale non può avere un valore di visibilità';
  end if;
  if t = 'Visibilità' and new.id_glb is not null then
    raise exception 'Un''opzione di tipo Visibilità non può avere un GLB materiale';
  end if;
  if new.id_glb is not null and exists (
    select 1 from risorse_glb where id_glb = new.id_glb and tipo_risorsa <> 'Materiale'
  ) then
    raise exception 'Il GLB dell''opzione deve essere di tipo Materiale';
  end if;
  return new;
end $$;
create trigger opzioni_check before insert or update on opzioni
  for each row execute function trg_opzioni_check();

-- Ogni nuova opzione è esposta dal proprio attributo generale.
create function trg_opzioni_expose() returns trigger language plpgsql as $$
begin
  insert into attributi_opzioni (id_attributo, id_opzione, ordine, abilitata)
  values (new.id_attributo, new.id_opzione, new.ordine, true);
  return new;
end $$;
create trigger opzioni_expose after insert on opzioni
  for each row execute function trg_opzioni_expose();

-- Le opzioni di un derivato devono appartenere all'attributo padre.
create function trg_attributi_opzioni_check() returns trigger language plpgsql as $$
declare padre bigint; proprietario bigint;
begin
  select id_attributo_padre into padre from attributi where id_attributo = new.id_attributo;
  select id_attributo into proprietario from opzioni where id_opzione = new.id_opzione;
  if padre is null and proprietario <> new.id_attributo then
    raise exception 'Un attributo generale può esporre solo le proprie opzioni';
  end if;
  if padre is not null and proprietario <> padre then
    raise exception 'L''opzione non appartiene all''attributo padre del derivato';
  end if;
  return new;
end $$;
create trigger attributi_opzioni_check before insert or update on attributi_opzioni
  for each row execute function trg_attributi_opzioni_check();

-- Coerenza ruolo/tipo attributo nelle associazioni mesh.
create function trg_associazioni_mesh_check() returns trigger language plpgsql as $$
declare t text;
begin
  select tipo_attributo into t from attributi where id_attributo = new.id_attributo;
  if t <> new.ruolo then
    raise exception 'Il ruolo % non è coerente con il tipo dell''attributo (%)', new.ruolo, t;
  end if;
  return new;
end $$;
create trigger associazioni_mesh_check before insert or update on associazioni_mesh
  for each row execute function trg_associazioni_mesh_check();

-- Codifica: la misura appartiene al prodotto; le opzioni sono ammesse per il prodotto.
create function trg_codifica_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from misure where id_misura = new.id_misura and id_prodotto = new.id_prodotto) then
    raise exception 'La misura non appartiene al prodotto';
  end if;
  return new;
end $$;
create trigger codifica_check before insert or update on codifica
  for each row execute function trg_codifica_check();

create function trg_codifica_dettagli_check() returns trigger language plpgsql as $$
declare prod bigint;
begin
  select id_prodotto into prod from codifica where id_codice = new.id_codice;
  if not exists (select 1 from configurazioni
                 where id_prodotto = prod and id_attributo = new.id_attributo and id_opzione = new.id_opzione) then
    raise exception 'Opzione non ammessa per questo prodotto e attributo';
  end if;
  return new;
end $$;
create trigger codifica_dettagli_check before insert or update on codifica_dettagli
  for each row execute function trg_codifica_dettagli_check();

-- =========================================================================
-- Sicurezza: solo utenti autenticati (creare gli utenti da Authentication > Users)
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'risorse_glb','attributi','opzioni','attributi_opzioni','prodotti','misure',
    'prodotti_attributi','configurazioni','mesh_glb','associazioni_mesh','listini','codifica',
    'codifica_dettagli','prezzi','versioni_prodotto']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "autenticati" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Archivio privato dei GLB; i client autenticati possono gestire i file.
insert into storage.buckets (id, name, public)
values ('modelli-glb', 'modelli-glb', false)
on conflict (id) do nothing;

create policy "autenticati_glb_select" on storage.objects
  for select to authenticated using (bucket_id = 'modelli-glb');
create policy "autenticati_glb_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'modelli-glb');
create policy "autenticati_glb_update" on storage.objects
  for update to authenticated using (bucket_id = 'modelli-glb') with check (bucket_id = 'modelli-glb');
create policy "autenticati_glb_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'modelli-glb');

-- Flag "Testato e pronto all'uso" (Final Check). Se lo schema è già installato, esegui solo questo blocco.
alter table prodotti add column if not exists validato boolean not null default false;
alter table prodotti add column if not exists validato_il timestamptz;

-- Flag per includere l'attributo nelle combinazioni di codifica. I prodotti esistenti restano invariati.
alter table prodotti_attributi add column if not exists codifica boolean not null default true;

-- Condizionamenti specifici del prodotto (per database esistenti: conditions.sql).
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
