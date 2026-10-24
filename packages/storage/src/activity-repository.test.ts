import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import type { ActivityEvent, Session } from '@rewind/contracts';
import { SqliteActivityRepository } from './activity-repository';
import { SqliteSessionRepository } from './session-repository';

describe('SqliteActivityRepository', () => {
  let db: DatabaseSync;
  let sessionRepo: SqliteSessionRepository;
  let activityRepo: SqliteActivityRepository;

  const validSessionId = '00000000-0000-4000-8000-000000000001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');

    // Load and run initial migration
    const migrationSql = readFileSync(
      resolve(__dirname, '../../../db/migrations/001_initial.sql'),
      'utf8',
    );
    db.exec(migrationSql);

    sessionRepo = new SqliteSessionRepository(db);
    activityRepo = new SqliteActivityRepository(db);

    // Create a parent session so foreign key constraints are satisfied
    const session: Session = {
      id: validSessionId,
      status: 'active',
      startedAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z',
      endedAt: null,
    };
    await sessionRepo.save(session);
  });

  it('appends and lists activities for a session', async () => {
    const events: ActivityEvent[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        sessionId: validSessionId,
        source: 'windows',
        type: 'foreground',
        occurredAt: '2026-10-25T00:01:00.000Z',
        payload: {
          application: 'chrome.exe',
          windowTitle: 'Google Search',
        },
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        sessionId: validSessionId,
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:02:00.000Z',
        payload: {
          state: 'entered',
        },
      },
    ];

    const appendResult = await activityRepo.append(events);
    expect(appendResult.ok).toBe(true);

    const listResult = await activityRepo.list(validSessionId, 10);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(2);
      // Newest event first (occurredAt DESC)
      expect(listResult.value[0]!.id).toBe(events[1]!.id);
      expect(listResult.value[1]!.id).toBe(events[0]!.id);
      expect(listResult.value[1]!.payload).toEqual(events[0]!.payload);
    }
  });

  it('paginates using limit and before cursor', async () => {
    const events: ActivityEvent[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        sessionId: validSessionId,
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:01:00.000Z',
        payload: { state: 'entered' },
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        sessionId: validSessionId,
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:02:00.000Z',
        payload: { state: 'left' },
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        sessionId: validSessionId,
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:03:00.000Z',
        payload: { state: 'entered' },
      },
    ];

    await activityRepo.append(events);

    // Fetch page 1 (limit 2)
    const page1 = await activityRepo.list(validSessionId, 2);
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.value).toHaveLength(2);
      expect(page1.value[0]!.id).toBe(events[2]!.id); // 00:03:00
      expect(page1.value[1]!.id).toBe(events[1]!.id); // 00:02:00

      // Fetch page 2 before the last event of page 1
      const cursor = page1.value[1]!.occurredAt;
      const page2 = await activityRepo.list(validSessionId, 2, cursor);
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.value).toHaveLength(1);
        expect(page2.value[0]!.id).toBe(events[0]!.id); // 00:01:00
      }
    }
  });

  it('rolls back all events if any insert in the batch violates a foreign key constraint', async () => {
    const events: ActivityEvent[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        sessionId: validSessionId,
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:01:00.000Z',
        payload: { state: 'entered' },
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        // Non-existent session id -> Foreign key failure!
        sessionId: '99999999-9999-4000-8000-999999999999',
        source: 'windows',
        type: 'idle',
        occurredAt: '2026-10-25T00:02:00.000Z',
        payload: { state: 'left' },
      },
    ];

    const result = await activityRepo.append(events);
    expect(result.ok).toBe(false);

    // Verify transaction rollback: even event 1 must NOT exist in the database!
    const listResult = await activityRepo.list(validSessionId, 10);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(0);
    }
  });
});
