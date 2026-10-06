import type { OfflineReportDraft } from './autoSaveService';
import {
  canAttemptDraftCloudSync,
  classifyDraftCloudSyncError,
  getDraftCloudSyncMessage,
  isRecoverableDraftCloudError,
} from './draftCloudSyncState';

const draftWith = (values: Partial<OfflineReportDraft>): OfflineReportDraft =>
  ({
    id: 'draft-1',
    type: 'lotListing',
    title: '93372',
    contractNo: '93372',
    formData: {},
    lots: [],
    activeLotIdx: 0,
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
    ...values,
  }) as OfflineReportDraft;

describe('draft cloud sync state', () => {
  it('never cloud-syncs explicit Offline even when Force sync is requested', () => {
    expect(canAttemptDraftCloudSync(draftWith({ captureMode: 'offline' }), { force: true })).toBe(false);
    expect(canAttemptDraftCloudSync(draftWith({ formData: { captureMode: 'offline' } }))).toBe(false);
    expect(canAttemptDraftCloudSync(draftWith({ captureMode: 'online', manualSubmissionRequired: true }), { force: true })).toBe(false);
  });
  it('turns a 503 into a friendly retryable state with backoff', () => {
    const failure = classifyDraftCloudSyncError(
      { response: { status: 503 }, message: 'Request failed with status code 503' },
      0,
      1_000
    );

    expect(failure).toMatchObject({
      kind: 'transient_server',
      retryable: true,
      attempts: 1,
      retryAt: 31_000,
    });
    expect(failure.message).toContain('remains safe');
    expect(failure.message).not.toContain('status code 503');
  });

  it('does not automatically retry before the persisted retry time', () => {
    const draft = draftWith({
      cloudSyncError: 'The server is temporarily unavailable.',
      cloudSyncErrorKind: 'transient_server',
      cloudSyncRetryAt: 31_000,
    });

    expect(canAttemptDraftCloudSync(draft, { now: 30_999 })).toBe(false);
    expect(canAttemptDraftCloudSync(draft, { now: 31_000 })).toBe(true);
    expect(canAttemptDraftCloudSync(draft, { force: true, now: 1_000 })).toBe(true);
  });

  it('upgrades legacy raw 503 messages to the friendly waiting state', () => {
    const draft = draftWith({ cloudSyncError: 'Request failed with status code 503' });

    expect(isRecoverableDraftCloudError(draft)).toBe(true);
    expect(getDraftCloudSyncMessage(draft)).toBe(
      'The server is temporarily unavailable. This draft remains safe and will retry automatically.'
    );
  });
});
