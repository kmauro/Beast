import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool } from 'mysql2';
import type { DatabaseSchema } from './types.js';

export function createDatabase(databaseUrl: string): Kysely<DatabaseSchema> {
  const pool = createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    enableKeepAlive: true,
    timezone: 'Z',
  });

  return new Kysely<DatabaseSchema>({
    dialect: new MysqlDialect({ pool }),
  });
}

export async function checkDatabase(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`select 1`.execute(db);
}

export type BeastDatabase = Kysely<DatabaseSchema>;

