import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:5433/revessent" });
await c.connect();
const tables = await c.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
const migrations = await c.query("select count(*)::int n from drizzle.__drizzle_migrations");
const policies = await c.query("select count(*)::int n from pg_policies where tablename in ('webhook_events','stripe_connections')");
const idx = await c.query("select indexname from pg_indexes where tablename='webhook_events' and indexname like '%uq%'");
const fn = await c.query("select proname from pg_proc where proname='resolve_webhook_connection'");
const cols = await c.query("select column_name from information_schema.columns where table_name='webhook_events' and column_name in ('provider_created_at','object_type','object_id','account')");
const lc = await c.query("select column_name from information_schema.columns where table_name='stripe_connections' and column_name in ('webhook_endpoint_id','webhook_secret_enc','last_webhook_at')");
console.log(JSON.stringify({
  tables: tables.rows[0].n, migrations: migrations.rows[0].n,
  rlsPolicies: policies.rows[0].n, uniqueIdx: idx.rows.map(r => r.indexname),
  resolverFn: fn.rows.map(r => r.proname), newEventCols: cols.rows.map(r => r.column_name),
  newConnCols: lc.rows.map(r => r.column_name)
}, null, 1));
await c.end();
