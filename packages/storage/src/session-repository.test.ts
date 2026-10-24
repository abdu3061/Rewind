import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import type { Session } from '@rewind/contracts';
import { SqliteSessionRepository } from './session-repository';

describe('SqliteSessionRepository', () => {
  let db: DatabaseSync;
  let repo: SqliteSessionRepository;

  beforeEach(() => {
    // Create a fast, isolated in-memory SQLite database for each test
    db = new DatabaseSync(':memory:');

    // Load and run our migration file
    const migrationSql = readFileSync(
      resolve(__dirname, '../../../db/migrations/001_initial.sql'),
      'utf8',
    );
    db.exec(migrationSql);

    repo = new SqliteSessionRepository(db);
  });

  it('saves and retrieves a session by id', async () => {
    const session: Session = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'active',
      startedAt: '2026-10-24T20:00:00.000Z',
      updatedAt: '2026-10-24T20:00:00.000Z',
      endedAt: null,
    };

    const saveResult = await repo.save(session);
    expect(saveResult.ok).toBe(true);

    const getResult = await repo.get(session.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(session);
    }
  });

  it('returns null when a session is not found', async () => {
    const result = await repo.get('00000000-0000-4000-8000-999999999999');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('updates an existing session on conflict (UPSERT)', async () => {
    const initialSession: Session = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'active',
      startedAt: '2026-10-24T20:00:00.000Z',
      updatedAt: '2026-10-24T20:00:00.000Z',
      endedAt: null,
    };

    await repo.save(initialSession);

    const updatedSession: Session = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'ended',
      startedAt: '2026-10-24T20:00:00.000Z',
      updatedAt: '2026-10-24T21:00:00.000Z',
      endedAt: '2026-10-24T21:00:00.000Z',
    };

    const updateResult = await repo.save(updatedSession);
    expect(updateResult.ok).toBe(true);

    const getResult = await repo.get(initialSession.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(updatedSession);
    }
  });

  it('retrieves the latest session sorted by startedAt', async () => {
    const sessionOlder: Session = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'ended',
      startedAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T11:00:00.000Z',
      endedAt: '2026-10-24T11:00:00.000Z',
    };

    const sessionNewer: Session = {
      id: '00000000-0000-4000-8000-000000000002',
      status: 'active',
      startedAt: '2026-10-24T15:00:00.000Z',
      updatedAt: '2026-10-24T15:00:00.000Z',
      endedAt: null,
    };

    await repo.save(sessionOlder);
    await repo.save(sessionNewer);

    const latestResult = await repo.getLatest();
    expect(latestResult.ok).toBe(true);
    if (latestResult.ok) {
      expect(latestResult.value).toEqual(sessionNewer);
    }
  });
});
