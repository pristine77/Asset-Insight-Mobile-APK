/**
 * The background upload line (2026-10-02): order, one upload at a time, the
 * outcome of each attempt, Pause, waiting for signal and the account fence.
 * The real cancellation plumbing (uploadCancellation.ts) is used throughout;
 * only storage, the pre-upload check and the network wait are stand-ins.
 */
import {
  ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE,
  CONNECTION_KEPT_DROPPING_MESSAGE,
  EARLIER_UPLOAD_ACCEPTED_MESSAGE,
  EARLIER_UPLOAD_ACCEPTED_TITLE,
  KEPT_INTERRUPTED_MESSAGE,
  createBackgroundUploadManager,
  describeBackgroundUpload,
  type BackgroundUploadManager,
  type BackgroundUploadRequest,
} from './backgroundUploadManager';
import {
  beginUploadFinalization,
  cancellableUploadRequest,
  createUploadOperation,
  pauseActiveUploads,
  setUploadOwner,
  type UploadOperation,
} from './uploadCancellation';
import { setDraftCaptureMode } from './offlineDraftPolicy';
import OfflineCaptureStore from './offlineCaptureStore';
import OfflineQueueService from './offlineQueueService';
import AutoSaveService, { type OfflineReportDraft } from './autoSaveService';
import { prepareOfflineSubmission } from './offlineSubmissionService';
import type { DirectUploadProgressCallback, DirectUploadProgressStage } from './directR2UploadService';

let mockOwner: string | null = 'owner';
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: {
  fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined),
} }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: () => mockOwner, setSubmissionState: jest.fn(async () => undefined),
} }));
jest.mock('./offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));
jest.mock('./offlineQueueService', () => ({ __esModule: true, default: {
  getConnectivityStatus: jest.fn(async () => ({ status: 'online' })),
  // The real wording, so a notice reads as the form's alert would.
  getSubmissionError: jest.fn((error: unknown) => jest.requireActual('./connectivityService').getSubmissionError(error)),
} }));
jest.mock('./autoSaveService', () => ({ __esModule: true, default: { cleanupOrphanedMedia: jest.fn(async () => 0) } }));

const setSubmissionState = jest.mocked(OfflineCaptureStore.setSubmissionState);

/** Lets every pending promise and zero-delay timer run. */
async function flush() {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Transfer = {
  /** The service's own operation, created with the line's operation as its parent. */
  operation: UploadOperation;
  signal?: AbortSignal;
  progress(completedFiles: number, stage?: DirectUploadProgressStage): void;
  accept(receipt?: Record<string, unknown>): void;
  fail(error: unknown): void;
};

/**
 * Stands in for assetService.createAssetReport with { operation }: the
 * transfer is bound to an operation created with the caller's as parent and
 * is aborted when that operation is paused, as the real services' are.
 */
function service(draftId: string, totalFiles = 160) {
  const transfers: Transfer[] = [];
  const upload = jest.fn((onProgress: DirectUploadProgressCallback, parent: UploadOperation) => {
    const operation = createUploadOperation(parent);
    let settle!: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
    const answer = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const transfer: Transfer = {
      operation,
      progress: (completedFiles, stage = 'uploading') => {
        const percent = Math.round((completedFiles / totalFiles) * 100);
        onProgress(percent, { percent, stage, message: '', completedFiles, totalFiles, uploadedBytes: completedFiles, totalBytes: totalFiles });
      },
      accept: (receipt = {}) => settle.resolve({ accepted: true, jobId: `job-${draftId}`, reportId: `report-${draftId}`, message: 'Accepted', ...receipt }),
      fail: (error) => settle.reject(error),
    };
    transfers.push(transfer);
    return cancellableUploadRequest(operation, (signal) => { transfer.signal = signal; return answer; });
  });
  return { upload, transfers, last: () => transfers[transfers.length - 1] };
}

function job(name: string) {
  const draftId = `draft-${name}`;
  const fake = service(draftId);
  const request: BackgroundUploadRequest = {
    draftId, type: 'asset', ownerId: 'owner', title: `QA-${name}`, totalFiles: 160,
    draft: { id: draftId, ownerId: 'owner' } as unknown as OfflineReportDraft,
    upload: fake.upload,
  };
  return { draftId, request, ...fake };
}


const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const activeReport = () => ({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } }, message: 'Request failed with status code 409' });

let manager: BackgroundUploadManager;
const snapshot = () => manager.getSnapshot();
const activeId = () => snapshot().active!.id;

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'owner';
  setUploadOwner('owner');
  setSubmissionState.mockReset().mockResolvedValue(undefined as any);
  jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'online' } as any);
  manager = createBackgroundUploadManager();
});
afterEach(() => { manager.resetForTests(); });

describe('the line', () => {
  it('runs one upload at a time, first in, first out', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(job);
    for (const item of [a, b, c]) expect(manager.enqueue(item.request)).toBe(true);
    await flush();
    expect(snapshot().active).toMatchObject({ draftId: a.draftId, status: 'uploading' });
    expect(snapshot().queued.map((entry) => entry.draftId)).toEqual([b.draftId, c.draftId]);
    expect(snapshot().queued.map(describeBackgroundUpload)).toEqual(['Waiting in line', 'Waiting in line']);
    expect(b.upload).not.toHaveBeenCalled();
    a.last().accept();
    await flush();
    expect(b.upload).toHaveBeenCalledTimes(1);
    expect(c.upload).not.toHaveBeenCalled();
    b.last().accept();
    await flush();
    expect(c.upload).toHaveBeenCalledTimes(1);
    expect(a.upload.mock.invocationCallOrder[0]).toBeLessThan(b.upload.mock.invocationCallOrder[0]);
    expect(b.upload.mock.invocationCallOrder[0]).toBeLessThan(c.upload.mock.invocationCallOrder[0]);
  });

  it('records the upload as ready before the transfer, and as accepted with its report ID after', async () => {
    const accepted = jest.fn();
    manager.onAccepted(accepted);
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    expect(prepareOfflineSubmission).toHaveBeenCalledWith(a.request.draft);
    expect(setSubmissionState.mock.calls).toEqual([[a.draftId, 'ready']]);
    expect(setSubmissionState.mock.invocationCallOrder[0]).toBeLessThan(a.upload.mock.invocationCallOrder[0]);
    a.last().progress(45);
    expect(snapshot().active).toMatchObject({ completedFiles: 45, totalFiles: 160, percent: 28, canPause: true });
    expect(describeBackgroundUpload(snapshot().active!)).toBe('Uploading 45 of 160');
    a.last().accept();
    await flush();
    expect(setSubmissionState).toHaveBeenLastCalledWith(a.draftId, 'accepted', `report-${a.draftId}`);
    // The default age limit: the person may be taking the next report's photos.
    expect(AutoSaveService.cleanupOrphanedMedia).toHaveBeenCalledWith();
    expect(accepted).toHaveBeenCalledWith({ draftId: a.draftId, type: 'asset', reportId: `report-${a.draftId}` });
    expect(snapshot().notices).toEqual([expect.objectContaining({ kind: 'sent', heading: 'Sent', title: 'QA-a', autoDismiss: true })]);
    expect(snapshot().active).toBeNull();
    expect(manager.isBusy(a.draftId)).toBe(false);
    expect(manager.statusFor(a.draftId)).toBeUndefined();
  });

  it('refuses active or queued duplicates and permits an explicit new attempt after pause', async () => {
    const [a, b] = ['a', 'b'].map(job);
    expect(manager.enqueue(a.request)).toBe(true);
    expect(manager.enqueue(a.request)).toBe(false);
    expect(manager.enqueue(b.request)).toBe(true);
    expect(manager.enqueue(b.request)).toBe(false);
    await flush();
    a.last().fail(networkError());
    await flush();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    expect(manager.isBusy(a.draftId)).toBe(false);
    expect(manager.isBusy(b.draftId)).toBe(true);
    // Once paused, the draft belongs to the person again; a new Submit replaces the paused entry.
    expect(manager.isBusy(a.draftId)).toBe(false);
    expect(manager.enqueue(a.request)).toBe(true);
    expect(snapshot().held).toEqual([]);
    expect(snapshot().queued.map((entry) => entry.draftId)).toEqual([a.draftId]);
  });
});

describe('Pause and Resume in the bar', () => {
  it('stops that upload only; another upload keeps going and the next in line starts', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    // An upload a form runs at the same time (its own operation).
    const formUpload = createUploadOperation();
    a.last().progress(45);
    const transfer = a.last();
    expect(manager.pause(activeId())).toBe(true);
    expect(snapshot().active).toMatchObject({ draftId: a.draftId, pausing: true, canPause: false });
    expect(describeBackgroundUpload(snapshot().active!)).toBe('Pausing');
    expect(transfer.signal?.aborted).toBe(true);
    expect(transfer.operation.isActive()).toBe(false);
    expect(formUpload.isActive()).toBe(true);
    await flush();
    expect(setSubmissionState).toHaveBeenCalledWith(a.draftId, 'paused', undefined, expect.stringContaining('Upload paused'));
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused', completedFiles: 45 })]);
    expect(snapshot().notices).toEqual([]);
    expect(b.upload).toHaveBeenCalledTimes(1);
    expect(b.last().operation.isActive()).toBe(true);
    expect(formUpload.isActive()).toBe(true);
  });

  it('puts a resumed upload at the end of the line, as the person\'s own action', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(job);
    for (const item of [a, b, c]) manager.enqueue(item.request);
    await flush();
    manager.pause(activeId());
    await flush();
    expect(snapshot().active).toMatchObject({ draftId: b.draftId });
    const pausedId = snapshot().held[0].id;
    expect(manager.resume(pausedId)).toBe(true);
    expect(snapshot().queued.map((entry) => entry.draftId)).toEqual([c.draftId, a.draftId]);
    b.last().accept();
    await flush();
    c.last().accept();
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(2);
    expect(snapshot().active).toMatchObject({ draftId: a.draftId, status: 'uploading' });
  });

  it('pauses an upload waiting in line without starting it', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    expect(manager.pause(snapshot().queued[0].id)).toBe(true);
    await flush();
    expect(b.upload).not.toHaveBeenCalled();
    expect(setSubmissionState).toHaveBeenCalledWith(b.draftId, 'paused', undefined, expect.stringContaining('Upload paused'));
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: b.draftId, status: 'paused' })]);
    expect(snapshot().active).toMatchObject({ draftId: a.draftId, status: 'uploading' });
  });

  it('settles a Pause tapped during the checks before the transfer at once', async () => {
    const [a, b] = ['a', 'b'].map(job);
    // A check that does not answer must not keep the bar on "Pausing" or hold the line.
    jest.mocked(prepareOfflineSubmission).mockImplementationOnce(() => new Promise(() => {}));
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    expect(manager.pause(activeId())).toBe(true);
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    expect(b.upload).toHaveBeenCalledTimes(1);
  });

  it('is not held up by a transfer that does not stop when paused', async () => {
    const [a, b] = ['a', 'b'].map(job);
    // Ignores its operation and never answers.
    manager.enqueue({ ...a.request, upload: jest.fn(() => new Promise(() => {})) });
    manager.enqueue(b.request);
    await flush();
    expect(manager.pause(activeId())).toBe(true);
    await flush();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    expect(b.upload).toHaveBeenCalledTimes(1);
  });

  it('settles Pause even when ready and paused state writes never answer', async () => {
    const [a, b] = ['a', 'b'].map(job);
    let finishReady!: () => void;
    setSubmissionState.mockImplementation((id, state) => {
      if (id === a.draftId && state === 'ready') return new Promise(resolve => { finishReady = resolve as () => void; });
      if (id === a.draftId && state === 'paused') return new Promise(() => {});
      return Promise.resolve(undefined as any);
    });
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    expect(finishReady).toBeDefined();
    expect(manager.pause(activeId())).toBe(true);
    await flush();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    expect(b.upload).toHaveBeenCalledTimes(1);
    expect(a.upload).not.toHaveBeenCalled();
    // A late local write cannot authorize transport or remove the held draft.
    finishReady();
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(snapshot().held[0]).toMatchObject({ draftId: a.draftId, status: 'paused' });
  });

  it('bounds a stalled local ready write without sending any originals', async () => {
    jest.useFakeTimers();
    try {
      const a = job('a');
      setSubmissionState.mockImplementation((_id, state) => state === 'ready' ? new Promise(() => {}) : Promise.resolve(undefined as any));
      manager.enqueue(a.request);
      await jest.advanceTimersByTimeAsync(30_001);
      expect(a.upload).not.toHaveBeenCalled();
      expect(snapshot().active).toBeNull();
      expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    } finally { jest.useRealTimers(); }
  });

  // 2026-10-01: pausing during "Finalizing" threw away the server's acceptance.
  it('refuses Pause while the submission is being finalized', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    a.last().progress(160, 'finalizing');
    expect(snapshot().active).toMatchObject({ stage: 'finalizing', canPause: false });
    expect(describeBackgroundUpload(snapshot().active!)).toBe('Finalizing');
    expect(manager.pause(activeId())).toBe(false);
    expect(a.last().operation.isActive()).toBe(true);
    a.last().accept();
    await flush();
    expect(setSubmissionState).toHaveBeenLastCalledWith(a.draftId, 'accepted', `report-${a.draftId}`);
    expect(setSubmissionState).not.toHaveBeenCalledWith(a.draftId, 'paused', expect.anything(), expect.anything());
  });

  it('preserves an uncertain finalizing draft after an explicit Offline choice', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    // As directR2UploadService does before showing "Finalizing".
    const endFinalization = beginUploadFinalization();
    a.last().progress(160, 'finalizing');
    setDraftCaptureMode('new-report', 'offline');
    expect(a.last().operation.isActive()).toBe(false);
    a.last().accept();
    endFinalization();
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    expect(snapshot().notices).toEqual([]);
  });

  it('can pause this report while an unrelated submission is being finalized', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    const endFinalization = beginUploadFinalization();
    expect(manager.pause(activeId())).toBe(true);
    expect(a.last().operation.isActive()).toBe(false);
    endFinalization();
    await flush();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
  });
});

describe('outcomes that need the person', () => {
  it('holds an earlier acceptance for review and sends the next Submit to the form', async () => {
    const accepted = jest.fn();
    manager.onAccepted(accepted);
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    a.last().accept({ alreadyQueued: true });
    await flush();
    expect(setSubmissionState).not.toHaveBeenCalledWith(a.draftId, 'accepted', expect.anything());
    expect(setSubmissionState).not.toHaveBeenCalledWith(a.draftId, 'paused', expect.anything(), expect.anything());
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'attention', message: EARLIER_UPLOAD_ACCEPTED_MESSAGE })]);
    expect(snapshot().notices).toEqual([expect.objectContaining({ kind: 'attention', heading: EARLIER_UPLOAD_ACCEPTED_TITLE, draftId: a.draftId })]);
    expect(accepted).not.toHaveBeenCalled();
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    expect(manager.prefersForeground(a.draftId)).toBe(true);
    expect(b.upload).toHaveBeenCalledTimes(1);
    manager.consumeForegroundMark(a.draftId);
    expect(manager.prefersForeground(a.draftId)).toBe(false);
  });

  it.each([
    ['a report already processing', activeReport(), 'Report Already Processing'],
    ['changed photos', { response: { status: 409, data: { code: 'SUBMISSION_MANIFEST_CHANGED', data: { accepted: false, canSupersede: true } } } }, 'Upload needs checking'],
    ['a sign-in problem', { response: { status: 401 }, message: 'Unauthorized' }, 'Sign In Required'],
    ['a rejected request', { response: { status: 400, data: { message: 'Contract number is not valid.' } }, message: 'Bad request' }, 'Report Needs Attention'],
  ])('stops for %s, keeps the draft paused and marks it for the form', async (_name, error, heading) => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    a.last().fail(error);
    await flush();
    expect(setSubmissionState).toHaveBeenCalledWith(a.draftId, 'paused', undefined, (error as any).message);
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'attention' })]);
    expect(describeBackgroundUpload(snapshot().held[0])).toBe('Needs attention');
    expect(snapshot().notices).toEqual([expect.objectContaining({ kind: 'attention', heading, draftId: a.draftId })]);
    expect(manager.prefersForeground(a.draftId)).toBe(true);
    expect(manager.resume(snapshot().held[0].id)).toBe(false);
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(b.upload).toHaveBeenCalledTimes(1);
  });

  it('does not take an unconfirmed receipt as acceptance', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    a.last().accept({ accepted: false });
    await flush();
    expect(setSubmissionState).not.toHaveBeenCalledWith(a.draftId, 'accepted', expect.anything());
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'attention' })]);
    expect(manager.prefersForeground(a.draftId)).toBe(true);
  });

  it('stops when the check before the transfer refuses the draft', async () => {
    jest.mocked(prepareOfflineSubmission).mockRejectedValueOnce(new Error('2 original files are unavailable. Restore or replace them in the draft before submitting.'));
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'attention', message: expect.stringContaining('original files are unavailable') })]);
    expect(manager.prefersForeground(a.draftId)).toBe(true);
  });

  it('reports an acceptance this phone could not record as sent, and never sends it again', async () => {
    setSubmissionState.mockImplementation(async (_id, state) => {
      if (state === 'accepted') throw new Error('Local storage unavailable');
      return undefined as any;
    });
    const accepted = jest.fn();
    manager.onAccepted(accepted);
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request);
    manager.enqueue(b.request);
    await flush();
    a.last().accept();
    await flush();
    expect(snapshot().notices).toEqual([expect.objectContaining({
      kind: 'sent', heading: 'Upload accepted', message: ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE, autoDismiss: false,
    })]);
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ draftId: a.draftId }));
    expect(manager.statusFor(a.draftId)).toBeUndefined();
    expect(setSubmissionState).not.toHaveBeenCalledWith(a.draftId, 'paused', expect.anything(), expect.anything());
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(b.upload).toHaveBeenCalledTimes(1);
  });
});

describe('manual-only recovery', () => {
  it('holds a lost connection and every queued report until explicit Resume', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    a.last().progress(64);
    pauseActiveUploads('connection');
    await flush();
    expect(snapshot().active).toBeNull();
    expect(snapshot().queued).toEqual([]);
    expect(snapshot().held).toEqual(expect.arrayContaining([
      expect.objectContaining({ draftId: a.draftId, status: 'paused', completedFiles: 64 }),
      expect.objectContaining({ draftId: b.draftId, status: 'paused' }),
    ]));
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(b.upload).not.toHaveBeenCalled();
    expect(manager.resume(snapshot().held.find(row => row.draftId === a.draftId)!.id)).toBe(true);
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(2);
    expect(b.upload).not.toHaveBeenCalled();
  });

  it('keeps an offline submission paused without a watcher or future upload', async () => {
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValueOnce({ status: 'offline' } as any);
    const a = job('a'); manager.enqueue(a.request);
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: a.draftId, status: 'paused' })]);
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(manager.resume(snapshot().held[0].id)).toBe(true);
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(1);
  });

  it('never bypasses an explicit Offline choice on another report', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    setDraftCaptureMode('new-report', 'offline');
    await flush();
    expect(snapshot().active).toBeNull();
    expect(snapshot().held).toHaveLength(2);
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(b.upload).not.toHaveBeenCalled();
  });

  it('holds queued uploads when Offline is selected while acceptance is being saved', async () => {
    const [a, b] = ['a', 'b'].map(job);
    let finishAccepted!: () => void;
    setSubmissionState.mockImplementation((_id, state) => state === 'accepted'
      ? new Promise(resolve => { finishAccepted = resolve as () => void; })
      : Promise.resolve(undefined as any));
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    a.last().accept();
    await flush();
    expect(finishAccepted).toBeDefined();
    setDraftCaptureMode('new-report', 'offline');
    await flush();
    expect(snapshot().active).toBeNull();
    expect(snapshot().queued).toEqual([]);
    expect(snapshot().held).toEqual([expect.objectContaining({ draftId: b.draftId, status: 'paused' })]);
    expect(snapshot().notices).toEqual([expect.objectContaining({ draftId: a.draftId, heading: 'Upload accepted', autoDismiss: false })]);
    expect(b.upload).not.toHaveBeenCalled();
    finishAccepted();
    await flush();
    expect(b.upload).not.toHaveBeenCalled();
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(snapshot().held).toHaveLength(1);
  });

  it('bounds an unanswered acceptance write without offering to upload the accepted report again', async () => {
    jest.useFakeTimers();
    try {
      const a = job('a');
      setSubmissionState.mockImplementation((_id, state) => state === 'accepted' ? new Promise(() => {}) : Promise.resolve(undefined as any));
      manager.enqueue(a.request);
      await jest.advanceTimersByTimeAsync(1);
      a.last().accept();
      await jest.advanceTimersByTimeAsync(30_001);
      expect(snapshot().active).toBeNull();
      expect(snapshot().held).toEqual([]);
      expect(snapshot().notices).toEqual([expect.objectContaining({ heading: 'Upload accepted', autoDismiss: false })]);
      expect(a.upload).toHaveBeenCalledTimes(1);
      expect(setSubmissionState.mock.calls.some(([, state]) => state === 'paused')).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  it('holds the rest of the line if global Offline follows a per-report Pause', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    expect(manager.pause(activeId())).toBe(true);
    setDraftCaptureMode('new-report', 'offline');
    await flush();
    expect(snapshot().active).toBeNull();
    expect(snapshot().queued).toEqual([]);
    expect(snapshot().held).toHaveLength(2);
    expect(b.upload).not.toHaveBeenCalled();
  });

  it('requires explicit Resume for transient errors even after network recovery', async () => {
    const a = job('a'); manager.enqueue(a.request);
    await flush();
    a.last().fail(networkError());
    await flush();
    expect(snapshot().held).toEqual([expect.objectContaining({ status: 'paused' })]);
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(manager.resume(snapshot().held[0].id)).toBe(true);
    await flush();
    expect(a.upload).toHaveBeenCalledTimes(2);
  });
});

describe('a change of account', () => {
  afterEach(() => { mockOwner = 'owner'; setUploadOwner('owner'); });

  it('fences a queued pause before its deferred local write after switching owner', async () => {
    const [a, b] = ['a', 'b'].map(job);
    manager.enqueue(a.request); manager.enqueue(b.request);
    await flush();
    setSubmissionState.mockClear();
    manager.pause(snapshot().queued[0].id);
    mockOwner = 'other-owner'; setUploadOwner('other-owner');
    await flush();
    expect(setSubmissionState).not.toHaveBeenCalled();
    expect(b.upload).not.toHaveBeenCalled();
    expect(snapshot()).toEqual({ active: null, queued: [], held: [], notices: [] });
  });

  it('empties the line and writes nothing for the old account', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(job);
    for (const item of [a, b, c]) manager.enqueue(item.request);
    await flush();
    // a uploading, b waiting in line, c paused.
    manager.pause(snapshot().queued[1].id);
    await flush();
    expect(snapshot().held).toHaveLength(1);
    const transfer = a.last();
    const listener = jest.fn();
    manager.subscribe(listener);
    setSubmissionState.mockClear();
    mockOwner = 'other-owner';
    setUploadOwner('other-owner');
    expect(snapshot()).toEqual({ active: null, queued: [], held: [], notices: [] });
    expect(listener).toHaveBeenCalled();
    expect(transfer.operation.isActive()).toBe(false);
    expect(transfer.signal?.aborted).toBe(true);
    // A late answer for the old account changes nothing.
    transfer.accept();
    await flush();
    expect(setSubmissionState).not.toHaveBeenCalled();
    expect(b.upload).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
  });

  it('never starts an upload queued for another account', async () => {
    const a = job('a');
    mockOwner = 'other-owner';
    setUploadOwner('other-owner');
    expect(manager.enqueue(a.request)).toBe(true);
    await flush();
    expect(a.upload).not.toHaveBeenCalled();
    expect(setSubmissionState).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
  });

  it('forgets the needs-attention marks of the old account', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    a.last().fail(activeReport());
    await flush();
    expect(manager.prefersForeground(a.draftId)).toBe(true);
    mockOwner = 'other-owner';
    setUploadOwner('other-owner');
    expect(manager.prefersForeground(a.draftId)).toBe(false);
  });
});

describe('handing a draft back', () => {
  it('forget() drops a held entry and its notice so the form owns the draft, keeping the foreground mark', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    a.last().fail(activeReport());
    await flush();
    expect(snapshot().held).toHaveLength(1);
    expect(snapshot().notices).toHaveLength(1);
    expect(manager.forget(a.draftId)).toBe(true);
    expect(snapshot().held).toEqual([]);
    expect(snapshot().notices).toEqual([]);
    expect(manager.forget(a.draftId)).toBe(false);
    // The form's next Submit still runs in the form, where its prompt appears.
    expect(manager.prefersForeground(a.draftId)).toBe(true);
  });

  it('dismiss() removes one notice', async () => {
    const a = job('a');
    manager.enqueue(a.request);
    await flush();
    a.last().accept();
    await flush();
    manager.dismiss(snapshot().notices[0].id);
    expect(snapshot().notices).toEqual([]);
  });
});
