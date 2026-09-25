import pg from "pg";

export type Db = pg.Pool;

export function createPool(url: string, ssl: boolean): Db {
  return new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}
