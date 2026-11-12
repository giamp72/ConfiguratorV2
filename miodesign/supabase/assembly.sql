-- MIODesign — assemblaggi per misura (PostgreSQL 15+).
-- Eseguire una sola volta dopo schema.sql, nello stesso schema (public).
-- Non migra misure.id_glb né associazioni_mesh: le vecchie associazioni
-- possono coesistere, ma non vengono lette o sincronizzate da queste tabelle.
--
-- Interfaccia:
-- * Inserire una riga in componenti_misura per ogni istanza, anche quando
--   più istanze usano lo stesso id_glb. id_prodotto deve essere quello della
--   misura; il GLB deve essere una risorsa di tipo Oggetto.
-- * Inserire in associazioni_mesh_componenti id_componente, id_prodotto,
--   id_glb, id_mesh, id_attributo e ruolo. id_prodotto e id_glb sono copiati
--   dal componente; la mesh deve appartenere a quel GLB, l'attributo deve
--   essere assegnato al prodotto e il suo tipo deve coincidere con il ruolo.
--   Al massimo un attributo per (componente, mesh, ruolo).
-- * Per visualizzare una misura, ordinare i componenti per ordine e poi
--   id_componente, caricare un'istanza del GLB per riga e applicare le sole
--   associazioni di quel componente ai nodi mesh identificati da percorso_nodo.
--   Le posizioni sono espresse in metri (unità glTF), indipendentemente da
--   misure.unita_misura; il client converte eventuali input in cm o mm in
--   metri (rispettivamente /100 o /1000). Le rotazioni sono angoli Euler XYZ
--   in gradi, in un sistema destrorso; convertirle in radianti (gradi * π / 180)
--   per API come loadAssembly che richiedono radianti. La matrice del componente è
--   T * Rx * Ry * Rz, premoltiplicata alle trasformazioni originali del GLB.
-- * Le modifiche che romperebbero un riferimento sono impedite: rimuovere prima
--   le righe dipendenti interessate e ricrearle dopo la modifica. Eliminando una
--   misura, componente, mesh o assegnazione prodotto/
--   attributo, le relative righe dipendenti vengono eliminate a cascata.
--   Il codice applicativo deve essere aggiornato esplicitamente per usare questa
--   interfaccia; misure.id_glb e associazioni_mesh restano indipendenti.

begin;

-- Chiavi composte necessarie ai riferimenti di integrità, anche in caso di
-- modifiche successive alle righe padre.
alter table misure
  add constraint misure_id_prodotto_assembly_key unique (id_misura, id_prodotto);
alter table risorse_glb
  add constraint risorse_glb_id_tipo_assembly_key unique (id_glb, tipo_risorsa);
alter table mesh_glb
  add constraint mesh_glb_id_glb_assembly_key unique (id_mesh, id_glb);
alter table attributi
  add constraint attributi_id_tipo_assembly_key unique (id_attributo, tipo_attributo);

create table componenti_misura (
  id_componente bigint generated always as identity primary key,
  id_misura     bigint not null,
  id_prodotto   bigint not null,
  id_glb        bigint not null,
  tipo_risorsa  varchar(20) not null default 'Oggetto' check (tipo_risorsa = 'Oggetto'),
  nome          varchar(200) not null,
  -- Metri glTF, indipendenti dall'unità delle dimensioni della misura.
  posizione_x   numeric not null default 0,
  posizione_y   numeric not null default 0,
  posizione_z   numeric not null default 0,
  -- Angoli Euler XYZ in gradi.
  rotazione_x   numeric not null default 0,
  rotazione_y   numeric not null default 0,
  rotazione_z   numeric not null default 0,
  ordine        integer not null default 0,
  unique (id_componente, id_prodotto, id_glb),
  foreign key (id_misura, id_prodotto)
    references misure (id_misura, id_prodotto) on delete cascade,
  foreign key (id_glb, tipo_risorsa)
    references risorse_glb (id_glb, tipo_risorsa)
);
create index componenti_misura_misura_idx on componenti_misura (id_misura, id_prodotto);
create index componenti_misura_glb_idx on componenti_misura (id_glb, tipo_risorsa);

create table associazioni_mesh_componenti (
  id_associazione bigint generated always as identity primary key,
  id_componente   bigint not null,
  id_prodotto     bigint not null,
  id_glb          bigint not null,
  id_mesh         bigint not null,
  id_attributo    bigint not null,
  ruolo           varchar(20) not null check (ruolo in ('Materiale', 'Visibilità')),
  unique (id_componente, id_mesh, ruolo),
  foreign key (id_componente, id_prodotto, id_glb)
    references componenti_misura (id_componente, id_prodotto, id_glb) on delete cascade,
  foreign key (id_mesh, id_glb)
    references mesh_glb (id_mesh, id_glb) on delete cascade,
  foreign key (id_prodotto, id_attributo)
    references prodotti_attributi (id_prodotto, id_attributo) on delete cascade,
  foreign key (id_attributo, ruolo)
    references attributi (id_attributo, tipo_attributo)
);
create index associazioni_componenti_mesh_idx on associazioni_mesh_componenti (id_mesh, id_glb);
create index associazioni_componenti_prodotto_attributo_idx
  on associazioni_mesh_componenti (id_prodotto, id_attributo);
create index associazioni_componenti_attributo_ruolo_idx
  on associazioni_mesh_componenti (id_attributo, ruolo);

alter table componenti_misura enable row level security;
alter table associazioni_mesh_componenti enable row level security;
create policy "autenticati" on componenti_misura
  for all to authenticated using (true) with check (true);
create policy "autenticati" on associazioni_mesh_componenti
  for all to authenticated using (true) with check (true);

commit;
