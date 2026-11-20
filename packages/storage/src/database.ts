/** Minimal SQL port shared by the existing repositories and the encrypted adapter. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface DatabaseConnection {
  prepare(sql: string): {
    run(...values: SqlValue[]): { changes: number | bigint };
    get(...values: SqlValue[]): Record<string, unknown> | undefined;
    all(...values: SqlValue[]): unknown[];
  };
  exec(sql: string): unknown;
  readonly isTransaction: boolean;
}
