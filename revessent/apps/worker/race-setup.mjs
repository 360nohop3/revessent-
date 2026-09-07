import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:5433/revessent" });
await c.connect();
const org = (await c.query("insert into organizations (id, name, slug) values (gen_random_uuid(), 'race', 'race-probe-' || floor(random()*1e6)::text) returning id")).rows[0].id;
const job = (await c.query("insert into job_runs (id, org_id, queue, job_type, dedupe_key, case_id) values (gen_random_uuid(), $1, 'retries', 'retry.execute', 'race-probe-key', null) returning id", [org])).rows[0].id;
console.log(JSON.stringify({ org, job }));
await c.end();
