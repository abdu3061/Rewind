import { describe, expect, it } from 'vitest';
import {
  activityEventSchema,
  createDefaultSettings,
  httpUrlSchema,
  recoveryProposalSchema,
  recoveryResultSchema,
  searchQuerySchema,
  searchResultSchema,
  sessionCommandSchema,
  sessionResponseSchema,
  sessionSchema,
  timestampSchema,
  userSettingsSchema,
} from './index';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-01-01T00:00:00.000Z';

describe('trust-boundary contracts', () => {
  it('accepts canonical UTC milliseconds and rejects local/offset timestamps', () => {
    expect(timestampSchema.safeParse(at).success).toBe(true);
    for (const value of ['2026-01-01T03:00:00.000+03:00', '2026-01-01T00:00:00', 'not-a-date']) {
      expect(timestampSchema.safeParse(value).success).toBe(false);
    }
  });
  it('rejects unknown IPC actions, properties, and malformed responses', () => {
    for (const input of [
      { action: 'delete' },
      { action: 'start', path: 'C:\\secret' },
      null,
      'start',
    ]) {
      expect(sessionCommandSchema.safeParse(input).success).toBe(false);
    }
    expect(sessionResponseSchema.safeParse({ ok: true, value: { session: null } }).success).toBe(
      true,
    );
    expect(
      sessionResponseSchema.safeParse({
        ok: false,
        error: { code: 'INVALID_TRANSITION', message: 'Cannot pause.' },
      }).success,
    ).toBe(true);
    expect(
      sessionResponseSchema.safeParse({ ok: true, value: { session: 'active' } }).success,
    ).toBe(false);
  });
  it('requires ended timestamps only for ended sessions', () => {
    const session = { id, status: 'active', startedAt: at, updatedAt: at, endedAt: null };
    expect(sessionSchema.safeParse(session).success).toBe(true);
    expect(sessionSchema.safeParse({ ...session, status: 'ended' }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...session, endedAt: at }).success).toBe(false);
  });
  it('requires event payloads and sources to agree with their type', () => {
    const event = {
      id,
      sessionId: id,
      occurredAt: at,
      source: 'windows',
      type: 'foreground',
      payload: { application: 'Editor', windowTitle: 'notes' },
    };
    expect(activityEventSchema.safeParse(event).success).toBe(true);
    expect(activityEventSchema.safeParse({ ...event, type: 'file-change' }).success).toBe(false);
    expect(activityEventSchema.safeParse({ ...event, source: 'browser' }).success).toBe(false);
  });
  it('requires explicit source references on search evidence and bounded queries', () => {
    expect(searchQuerySchema.safeParse({ text: 'notes', mode: 'keyword', limit: 20 }).success).toBe(
      true,
    );
    expect(searchQuerySchema.safeParse({ text: '', mode: 'keyword', limit: 1000 }).success).toBe(
      false,
    );
    const result = {
      title: 'notes',
      excerpt: 'saved notes',
      occurredAt: at,
      evidence: 'recorded',
      source: { kind: 'file-version', fileId: id, fileVersionId: id },
    };
    expect(searchResultSchema.safeParse(result).success).toBe(true);
    expect(
      searchResultSchema.safeParse({ ...result, source: { kind: 'file-version', fileId: id } })
        .success,
    ).toBe(false);
  });
  it('rejects unsafe URL protocols and embedded credentials', () => {
    expect(httpUrlSchema.safeParse('https://example.com/article').success).toBe(true);
    for (const url of [
      'file:///C:/secret.txt',
      'javascript:alert(1)',
      'https://user:pass@example.com',
    ]) {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    }
  });
  it('requires confirmation and current-file preservation for overwrite proposals', () => {
    const proposal = {
      id,
      fileId: id,
      fileVersionId: id,
      createdAt: at,
      expiresAt: at,
      mode: 'overwrite',
      destinationLabel: 'notes.txt',
      requiresConfirmation: true,
      requiresCurrentFilePreservation: true,
    };
    expect(recoveryProposalSchema.safeParse(proposal).success).toBe(true);
    expect(
      recoveryProposalSchema.safeParse({ ...proposal, requiresConfirmation: false }).success,
    ).toBe(false);
    expect(
      recoveryProposalSchema.safeParse({ ...proposal, requiresCurrentFilePreservation: false })
        .success,
    ).toBe(false);
    expect(
      recoveryResultSchema.safeParse({
        proposalId: id,
        recoveredFileId: id,
        recoveredAt: at,
        mode: 'overwrite',
        preservedCurrentVersionId: null,
      }).success,
    ).toBe(false);
  });
  it('defaults every collection and cloud gate to off and returns independent settings', () => {
    const settings = createDefaultSettings();
    expect(userSettingsSchema.safeParse(settings).success).toBe(true);
    expect(settings).toMatchObject({
      collectionConsent: false,
      cloudAiEnabled: false,
      articleExtractionEnabled: false,
      retentionHours: 72,
    });
    settings.excludedApplications.push('Editor');
    expect(createDefaultSettings().excludedApplications).toEqual([]);
  });
});
