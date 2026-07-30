import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleRoot = process.env.PGLITE_MODULE_ROOT;
if (!moduleRoot) {
  throw new Error('PGLITE_MODULE_ROOT must point to @electric-sql/pglite');
}

const { PGlite } = await import(pathToFileURL(join(moduleRoot, 'dist/index.js')));
const { btree_gist } = await import(pathToFileURL(join(moduleRoot, 'dist/contrib/btree_gist.js')));

const db = new PGlite({ extensions: { btree_gist } });
await db.waitReady;

const runtimeRoleBootstrap = readFileSync(
  resolve('database/bootstrap/001-create-runtime-role.sql'),
  'utf8',
);
await db.exec(runtimeRoleBootstrap);
await db.exec(runtimeRoleBootstrap);
const runtimeRole = await db.query(
  "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'innorder_runtime'",
);
if (runtimeRole.rows.length !== 1 || runtimeRole.rows[0].rolcanlogin !== false) {
  throw new Error('runtime role bootstrap must be idempotent and create a NOLOGIN role');
}
console.log('passed idempotent NOLOGIN runtime role bootstrap');

const migrationDir = resolve('database/migrations');
const migrations = [
  'V001__bootstrap.sql',
  'V002__catalog.sql',
  'V003__identity_and_entities.sql',
  'V004__policy_control_plane.sql',
  'V005__occ_runtime.sql',
  'V006__audit_and_outbox.sql',
  'V007__ai_rag.sql',
  'V008__cross_schema_constraints.sql',
  'V009__runtime_privileges.sql',
  'V010__platform_security_kernel.sql',
];

for (const migration of migrations) {
  let sql = readFileSync(join(migrationDir, migration), 'utf8');
  if (migration === 'V001__bootstrap.sql') {
    sql = sql.replace(
      /CREATE EXTENSION IF NOT EXISTS vector;/i,
      'CREATE DOMAIN vector AS double precision[];',
    );
  }
  await db.exec(sql);
  console.log(`applied ${migration}`);
}

for (const testFile of ['000_assert.sql', '001_schema_contract.sql', '002_constraints.sql']) {
  const sql = readFileSync(resolve('database/tests', testFile), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replace(
      /EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'vector'\)/i,
      "EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector')",
    );
  await db.exec(sql);
  console.log(`passed ${testFile}`);
}

await db.close();
console.log('PGlite PostgreSQL smoke test passed');
