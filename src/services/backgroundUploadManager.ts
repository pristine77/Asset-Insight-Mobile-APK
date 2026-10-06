/**
 * Explicit Submit hands one frozen report to an in-app background upload line.
 * One upload runs at a time; navigation may continue. Interruption, Offline,
 * restart and reconnect NEVER resume it. Resume is an explicit user action.
 * Owner switches clear this in-memory line while preserving durable drafts.
 */
import type { OfflineDraftType, OfflineReportDraft } from './autoSaveService';
import { assertReportUploadAccepted, isExistingReportUploadReceipt } from './reportUploadReceipt';
import type { DirectUploadProgressCallback, DirectUploadProgressStage } from './directR2UploadService';
import {
  cancellableUploadTask,
  createUploadOperation,
  onUploadOwnerChange,
  onUploadsPaused,
  pauseUploadOperation,
  type UploadOperation,
} from './uploadCancellation';
import { isUploadManifestConflict } from '../components/forms/uploadManifestRecovery';

/*
 * The upload stack is required when it is first used, not imported at the top.
 * The upload bar and the Drafts lists import this module only to read the line;
 * they must not load native storage and network modules for that (their tests
 * run without them, and a status line has no use for the upload stack).
 * require() is synchronous and cached by the bundler, so each call is cheap.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate lazy loading, see above */
const captureStore = (): typeof import('./offlineCaptureStore').default => require('./offlineCaptureStore').default;
const queueService = (): typeof import('./offlineQueueService').default => require('./offlineQueueService').default;
const autoSave = (): typeof import('./autoSaveService').default => require('./autoSaveService').default;
const submission = (): typeof import('./offlineSubmissionService') => require('./offlineSubmissionService');
const resumePolicy = (): typeof import('./uploadResumePolicy') => require('./uploadResumePolicy');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Shown where a busy draft cannot be opened (the forms' draft loading). */
export const BACKGROUND_UPLOAD_BUSY_MESSAGE =
  'This report is uploading in the background. Open it again when the upload finishes or after pausing it.';
/** Shown when Submit finds this draft already in the background line. */
export const ALREADY_UPLOADING_TITLE = 'Already uploading';
export const ALREADY_UPLOADING_MESSAGE =
  'This report is already uploading in the background. The upload bar on the main screen shows its progress.';
// The forms' own wording, so one outcome reads the same wherever it appears.
export const EARLIER_UPLOAD_ACCEPTED_TITLE = 'Earlier upload accepted';
export const EARLIER_UPLOAD_ACCEPTED_MESSAGE =
  'The server returned the earlier report, not confirmation of your current edits. This draft and its originals are kept. Open Reports or Previews to review the earlier report before making further changes.';
export const ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE =
  'The server accepted this report. Open Previews to check its progress; local confirmation could not be refreshed.';
export const CONNECTION_KEPT_DROPPING_MESSAGE =
  'The connection kept dropping before any more photos were sent. Your draft is saved. Tap Resume when the signal is steady.';
export const KEPT_INTERRUPTED_MESSAGE =
  'The upload kept being interrupted before any more photos were sent. Your draft is saved. Tap Resume to try again.';
export const SENT_MESSAGE = 'Processing continues on the server. You will receive an email when the files are ready.';
export const PAUSED_MESSAGE =
  'Upload paused. Your draft is saved. Resume this same upload to check whether the server already accepted it.';
const NO_CONNECTION_MESSAGE = 'No connection. Your draft is saved. Connect and tap Resume upload.';
/** Notices kept for the bar; older ones fall off. */
const MAX_NOTICES = 10;
const LOCAL_STATE_TIMEOUT_MS = 30_000;

export type BackgroundUploadStatus = 'queued' | 'uploading' | 'waiting' | 'paused' | 'attention';

/** What a form hands over: everything one attempt needs, frozen at Submit. */
export type BackgroundUploadRequest = {
  draftId: string;
  type: OfflineDraftType;
  ownerId: string;
  /** Contract number or report name, for the bar and its notices. */
  title: string;
  totalFiles: number;
  /** The draft as saved at Submit; prepareOfflineSubmission() re-reads and re-checks it each attempt. */
  draft: OfflineReportDraft;
  /** Calls the form's own service with the form's details and lots, passing operation through. */
  upload: (onProgress: DirectUploadProgressCallback, operation: UploadOperation) => Promise<unknown>;
};

export type BackgroundUploadEntry = {
  id: string;
  draftId: string;
  type: OfflineDraftType;
  title: string;
  status: BackgroundUploadStatus;
  stage?: DirectUploadProgressStage;
  percent: number;
  completedFiles: number;
  totalFiles: number;
  /** Pause was tapped and the transfer is stopping. */
  pausing: boolean;
  /** Whether Pause may be offered; false while the submission is being finalized. */
  canPause: boolean;
  message?: string;
};

export type BackgroundUploadNotice = {
  id: string;
  kind: 'sent' | 'attention';
  jobId: string;
  draftId: string;
  type: OfflineDraftType;
  title: string;
  heading: string;
  message: string;
  reportId?: string;
  /**
   * Only an ordinary "Sent" goes away by itself. An acceptance this phone could
   * not record stays until dismissed: the draft still shows Resume upload, and
   * the message says the report is accepted all the same.
   */
  autoDismiss: boolean;
};

export type BackgroundUploadSnapshot = {
  active: BackgroundUploadEntry | null;
  queued: BackgroundUploadEntry[];
  /** Paused and needs-attention uploads, oldest first. */
  held: BackgroundUploadEntry[];
  notices: BackgroundUploadNotice[];
};

export type BackgroundUploadAccepted = { draftId: string; type: OfflineDraftType; reportId?: string };

type Job = BackgroundUploadRequest & {
  id: string;
  status: BackgroundUploadStatus;
  stage?: DirectUploadProgressStage;
  percent: number;
  completedFiles: number;
  message?: string;
  /** Set by the bar's Pause before the operation is cancelled, so the failure reads as a pause. */
  pauseRequested: boolean;
  operation?: UploadOperation;
  watcher?: AbortController;
};

const errorMessage = (error: unknown): string | undefined => {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
};
const isPausedError = (error: unknown) => String((error as any)?.code || '').toUpperCase() === 'ERR_CANCELED';
const isActiveReportConflict = (error: any) =>
  error?.response?.status === 409 && error?.response?.data?.code === 'ACTIVE_REPORT_EXISTS';

/** Short status for a Drafts card: "Uploading 45 of 160", "Waiting in line" and so on. */
export function describeBackgroundUpload(entry: BackgroundUploadEntry): string {
  if (entry.status === 'queued') return 'Waiting in line';
  if (entry.status === 'waiting') return 'Waiting for signal';
  if (entry.status === 'paused') return 'Paused';
  if (entry.status === 'attention') return 'Needs attention';
  if (entry.pausing) return 'Pausing';
  if (entry.stage === 'finalizing' || entry.stage === 'complete') return 'Finalizing';
  return `Uploading ${entry.completedFiles} of ${entry.totalFiles}`;
}

export function createBackgroundUploadManager() {
  // Bumped when the line is emptied (owner change, test reset): work started
  // before that never writes or notifies again.
  let generation = 0;
  let sequence = 0;
  let active: Job | null = null;
  let queue: Job[] = [];
  let held: Job[] = [];
  let notices: BackgroundUploadNotice[] = [];
  // Drafts whose next Submit or Resume must run in the form, where its prompts can appear.
  const foreground = new Set<string>();
  const listeners = new Set<() => void>();
  const acceptedListeners = new Set<(event: BackgroundUploadAccepted) => void>();
  let snapshot: BackgroundUploadSnapshot = { active: null, queued: [], held: [], notices: [] };
  let unwatchOwner: (() => void) | null = null;
  let unwatchPause: (() => void) | null = null;

  const canPause = (job: Job) => {
    if (job.status === 'queued' || job.status === 'waiting') return true;
    if (job.status !== 'uploading' || job.pauseRequested) return false;
    return job.stage !== 'finalizing' && job.stage !== 'complete';
  };
  const toEntry = (job: Job): BackgroundUploadEntry => ({
    id: job.id,
    draftId: job.draftId,
    type: job.type,
    title: job.title,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    completedFiles: job.completedFiles,
    totalFiles: job.totalFiles,
    pausing: job.status === 'uploading' && job.pauseRequested,
    canPause: canPause(job),
    message: job.message,
  });

  /** Publishes a new snapshot (useSyncExternalStore needs a new object per change). */
  function notify() {
    snapshot = {
      active: active ? toEntry(active) : null,
      queued: queue.map(toEntry),
      held: held.map(toEntry),
      notices: notices.slice(),
    };
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch { /* A faulty view must not stop the line. */ }
    }
  }

  function addNotice(
    job: Job,
    kind: BackgroundUploadNotice['kind'],
    heading: string,
    message: string,
    extra: { reportId?: string; autoDismiss?: boolean } = {},
  ) {
    const notice: BackgroundUploadNotice = {
      id: `notice-${++sequence}`, kind, jobId: job.id, draftId: job.draftId, type: job.type,
      title: job.title, heading, message, reportId: extra.reportId, autoDismiss: extra.autoDismiss === true,
    };
    // One attention notice per draft: the newest replaces the older one.
    notices = [...notices.filter((item) => !(item.kind === 'attention' && item.draftId === job.draftId)), notice]
      .slice(-MAX_NOTICES);
  }

  /** Records the draft as paused; a storage failure must not stop the line. */
  function recordPaused(job: Job, message: string | undefined) {
    const expectedGeneration = generation;
    return Promise.resolve()
      .then(() => {
        if (generation !== expectedGeneration || captureStore().getOwnerId() !== job.ownerId) return;
        return captureStore().setSubmissionState(job.draftId, 'paused', undefined, message);
      })
      .catch(() => undefined);
  }

  function holdQueuedUploads() {
    const pending = queue;
    queue = [];
    for (const job of pending) {
      Object.assign(job, { status: 'paused', message: PAUSED_MESSAGE, pauseRequested: false });
      held.push(job);
      void recordPaused(job, PAUSED_MESSAGE);
    }
    if (pending.length) notify();
  }

  /** Starts the next upload in line when none is running, then tells the views. */
  function startNext() {
    if (!active) {
      const next = queue.shift();
      if (next) {
        active = next;
        // Its first synchronous step publishes the snapshot.
        void runAttempt(next);
        return;
      }
    }
    notify();
  }

  /** Takes a job out of the running slot or the line and keeps it as paused or needing attention. */
  function hold(job: Job, status: 'paused' | 'attention', message?: string) {
    job.watcher?.abort();
    Object.assign(job, { status, message, pauseRequested: false, operation: undefined, watcher: undefined });
    if (active === job) active = null;
    queue = queue.filter((item) => item !== job);
    held = [...held.filter((item) => item !== job), job];
    startNext();
  }

  /** Forgets a job without writing anything: its account is no longer signed in. */
  function drop(job: Job) {
    job.watcher?.abort();
    if (active === job) active = null;
    queue = queue.filter((item) => item !== job);
    startNext();
  }

  /**
   * The server accepted the upload; it leaves the line for good. recorded is
   * false when this phone could not record the acceptance: that notice stays
   * until dismissed, and the draft is never uploaded again from here.
   */
  function finishSent(job: Job, recorded: boolean, reportId?: string) {
    addNotice(job, 'sent', recorded ? 'Sent' : 'Upload accepted', recorded ? SENT_MESSAGE : ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE,
      { reportId, autoDismiss: recorded });
    if (active === job) active = null;
    const event: BackgroundUploadAccepted = { draftId: job.draftId, type: job.type, reportId };
    for (const listener of Array.from(acceptedListeners)) {
      try { listener(event); } catch { /* The upload is accepted whatever a view does with the news. */ }
    }
    startNext();
  }

  async function runAttempt(job: Job): Promise<void> {
    const attemptGeneration = generation;
    const current = () => generation === attemptGeneration && active === job;
    // Signed out or switched account since this was queued: never upload or write for it.
    if (captureStore().getOwnerId() !== job.ownerId) { drop(job); return; }
    if (job.pauseRequested) {
      // Pause was tapped between two attempts (a prompt retry was pending).
      void recordPaused(job, PAUSED_MESSAGE);
      hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    const operation = createUploadOperation();
    Object.assign(job, { status: 'uploading', stage: 'preparing', message: undefined, operation });
    notify();
    // Every step of the attempt stops waiting as soon as this upload is paused
    // or the account changes. The services already stop their transfers then;
    // this also covers the local checks (a storage read, the 6 s server check)
    // and any step that does not answer, so the bar never stays on "Pausing"
    // and the line is never held by one upload.
    const step = <T>(work: () => Promise<T>) => cancellableUploadTask(operation, () => work(), () => undefined);
    const localWrite = <T>(work: () => Promise<T>) => cancellableUploadTask(operation, () => work(), () => undefined, {
      idleTimeoutMs: LOCAL_STATE_TIMEOUT_MS,
      message: 'Saving upload status on this device took too long. Your originals are kept. Review the draft before resuming.',
    });
    let acceptedReportId: string | undefined;
    let accepted = false;
    try {
      // Every attempt re-checks the saved draft: owner, missing originals, an
      // acceptance recorded since, an Incoming assignment that changed.
      await step(() => submission().prepareOfflineSubmission(job.draft));
      const connectivity = await step(() => queueService().getConnectivityStatus());
      if (connectivity.status === 'offline') {
        throw Object.assign(new Error(NO_CONNECTION_MESSAGE), { code: resumePolicy().UPLOAD_WAITING_FOR_CONNECTION });
      }
      // Persist intent before transport, so a killed app reopens as Resume upload.
      await localWrite(() => captureStore().setSubmissionState(job.draftId, 'ready'));
      operation.assertActive();
      const response: any = await step(() => job.upload((percent, detail) => {
        if (!current() || !operation.isActive()) return;
        job.percent = percent;
        if (detail) {
          job.stage = detail.stage;
          job.completedFiles = detail.completedFiles;
          if (detail.totalFiles) job.totalFiles = detail.totalFiles;
        }
        notify();
      }, operation));
      assertReportUploadAccepted(response);
      accepted = true;
      acceptedReportId = typeof response.reportId === 'string' ? response.reportId : undefined;
      if (!current()) return;
      Object.assign(job, { stage: 'complete', percent: 100, completedFiles: job.totalFiles });
      notify();
      if (isExistingReportUploadReceipt(response)) {
        // The forms' rule: this receipt is the earlier report, not confirmation
        // of the current edits. The draft is left as it is for the person.
        foreground.add(job.draftId);
        addNotice(job, 'attention', EARLIER_UPLOAD_ACCEPTED_TITLE, EARLIER_UPLOAD_ACCEPTED_MESSAGE);
        hold(job, 'attention', EARLIER_UPLOAD_ACCEPTED_MESSAGE);
        return;
      }
      try {
        await localWrite(() => captureStore().setSubmissionState(job.draftId, 'accepted', acceptedReportId));
      } catch {
        // Accepted on the server: say so, and never upload this draft again from here.
        if (current()) finishSent(job, false, acceptedReportId);
        return;
      }
      if (!current()) return;
      // Default age limit, not the forms' 0 (2026-10-02): with 0 the cleanup
      // deletes every camera file no saved draft refers to yet, and the person
      // may be taking photos for the next report right now.
      void Promise.resolve().then(() => {
        if (generation !== attemptGeneration || captureStore().getOwnerId() !== job.ownerId) return;
        return autoSave().cleanupOrphanedMedia();
      }).catch(() => undefined);
      finishSent(job, true, acceptedReportId);
    } catch (error) {
      if (accepted) {
        if (current()) finishSent(job, false, acceptedReportId);
        return;
      }
      await handleFailure(job, error, current);
    }
  }

  async function handleFailure(job: Job, error: unknown, current: () => boolean) {
    if (!current()) return;
    // The account changed: nothing is written for the old account.
    if (captureStore().getOwnerId() !== job.ownerId) { drop(job); return; }

    // The attempt settles as soon as Pause cancels its operation (step() in
    // runAttempt), so a requested pause is what ended it.
    if (job.pauseRequested) {
      void recordPaused(job, errorMessage(error));
      if (current()) hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    // Decisions belong to the person, even when the status code looks transient.
    const conflict = isUploadManifestConflict(error) || isActiveReportConflict(error);
    if (!conflict && (resumePolicy().isInterruptedUpload(error) || isPausedError(error))) {
      void recordPaused(job, errorMessage(error));
      if (!current()) return;
      // A global pause (Offline/connection loss) must not start queued jobs.
      if (isPausedError(error)) {
        holdQueuedUploads();
      }
      hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    void recordPaused(job, errorMessage(error));
    if (!current()) return;
    const feedback = isUploadManifestConflict(error)
      ? {
          title: 'Upload needs checking',
          message: 'This upload needs your decision about the earlier upload of the same report. Open the draft and tap Resume upload to see the choices. Your draft and originals are kept.',
        }
      : isActiveReportConflict(error)
        ? {
            title: 'Report Already Processing',
            message: 'A report for this contract is already queued or processing. Open the draft and tap Resume upload to review it or create a separate report. Your draft and originals are kept.',
          }
        : queueService().getSubmissionError(error);
    // The next Submit or Resume of this draft runs in the form, where the
    // form's own prompt for this error appears.
    foreground.add(job.draftId);
    addNotice(job, 'attention', feedback.title, feedback.message);
    hold(job, 'attention', feedback.message);
  }

  /** Empties the line. Work already started stops and never writes again. */
  function clear() {
    generation += 1;
    const running = active;
    if (running) {
      running.watcher?.abort();
      if (running.operation?.isActive()) pauseUploadOperation(running.operation);
    }
    active = null;
    queue = [];
    held = [];
    notices = [];
    foreground.clear();
    notify();
  }

  const allJobs = () => [...(active ? [active] : []), ...queue, ...held];

  const manager = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot(): BackgroundUploadSnapshot {
      return snapshot;
    },
    /** Adds an upload to the end of the line. False when this draft is already queued or running. */
    enqueue(request: BackgroundUploadRequest): boolean {
      if (manager.isBusy(request.draftId)) return false;
      // Subscribed on first use, so importing this module has no side effects.
      if (!unwatchOwner) unwatchOwner = onUploadOwnerChange(() => clear());
      if (!unwatchPause) unwatchPause = onUploadsPaused(holdQueuedUploads);
      held = held.filter((job) => job.draftId !== request.draftId);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.draftId === request.draftId));
      const job: Job = {
        ...request,
        id: `background-upload-${++sequence}`,
        status: 'queued',
        percent: 0,
        completedFiles: 0,
        pauseRequested: false,
      };
      queue = [...queue, job];
      startNext();
      return true;
    },
    /** The bar's Pause. Refused while finalizing, when the server is accepting the report. */
    pause(jobId: string): boolean {
      const job = allJobs().find((item) => item.id === jobId);
      if (!job) return false;
      if (job.status === 'queued') {
        void recordPaused(job, PAUSED_MESSAGE);
        hold(job, 'paused', PAUSED_MESSAGE);
        return true;
      }
      if (job !== active) return false;
      if (job.status === 'waiting') {
        // The draft was already recorded as paused when the attempt failed.
        hold(job, 'paused', PAUSED_MESSAGE);
        return true;
      }
      if (job.status !== 'uploading' || job.pauseRequested) return false;
      if (job.stage === 'finalizing' || job.stage === 'complete') return false;
      job.pauseRequested = true;
      notify();
      // This upload only; the outcome arrives through the attempt's failure path.
      pauseUploadOperation(job.operation);
      return true;
    },
    /** Puts a paused upload back at the end of the line, as the person's own action. */
    resume(jobId: string): boolean {
      const job = held.find((item) => item.id === jobId);
      if (!job || job.status !== 'paused' || captureStore().getOwnerId() !== job.ownerId) return false;
      held = held.filter((item) => item !== job);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.jobId === job.id));
      Object.assign(job, { status: 'queued', message: undefined, pauseRequested: false });
      queue = [...queue, job];
      startNext();
      return true;
    },
    /** Waiting is not scheduled; callers use explicit Resume on a held job. */
    resumeNow(): boolean { return false; },
    dismiss(noticeId: string) {
      const before = notices.length;
      notices = notices.filter((notice) => notice.id !== noticeId);
      if (notices.length !== before) notify();
    },
    /**
     * Lets the form own a paused or needs-attention draft again (it is being
     * opened, discarded or restored from the cloud). Queued or running uploads
     * are not affected; check isBusy() first. The foreground mark stays, so
     * the form's next Submit still shows its prompts.
     */
    forget(draftId: string): boolean {
      const before = held.length + notices.length;
      held = held.filter((job) => job.draftId !== draftId);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.draftId === draftId));
      if (held.length + notices.length === before) return false;
      notify();
      return true;
    },
    /** Queued, uploading or waiting for signal: the draft must not be opened, discarded or overwritten. */
    isBusy(draftId: string): boolean {
      return active?.draftId === draftId || queue.some((job) => job.draftId === draftId);
    },
    statusFor(draftId: string): BackgroundUploadEntry | undefined {
      const job = allJobs().find((item) => item.draftId === draftId);
      return job ? toEntry(job) : undefined;
    },
    prefersForeground(draftId: string): boolean {
      return foreground.has(draftId);
    },
    /** Called when the foreground attempt that the mark asked for starts. */
    consumeForegroundMark(draftId: string) {
      foreground.delete(draftId);
    },
    /** Told when the server accepts an upload (the Dashboard refreshes its figures). */
    onAccepted(listener: (event: BackgroundUploadAccepted) => void): () => void {
      acceptedListeners.add(listener);
      return () => { acceptedListeners.delete(listener); };
    },
    /** Tests only: empties the line and its notices. */
    resetForTests() {
      clear();
      unwatchOwner?.(); unwatchOwner = null;
      unwatchPause?.(); unwatchPause = null;
      sequence = 0;
    },
  };
  return manager;
}

export type BackgroundUploadManager = ReturnType<typeof createBackgroundUploadManager>;

const backgroundUploadManager = createBackgroundUploadManager();
export default backgroundUploadManager;
