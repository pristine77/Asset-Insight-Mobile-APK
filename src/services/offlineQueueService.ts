import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { Alert, AppState, AppStateStatus, Platform } from 'react-native';
import assetService, { AssetCreateDetails, MixedLot as AssetMixedLot } from './assetService';
import lotListingService, {
  LotListingDetails,
  LotListingLot,
} from './lotListingService';
import AutoSaveService from './autoSaveService';
import { LocalMediaStore } from './localMediaStore';
import {
  type ConnectivityResult,
  getConnectivityStatus,
  getErrorStatus,
  getSubmissionError,
  isNetworkTransportError,
  isRetryableRequestError,
  shouldQueueAfterError,
} from './connectivityService';

const FileSystem = require('expo-file-system/legacy');

export type OfflineJobType = 'asset' | 'lotListing';

export type OfflineQueueJob = {
  id: string;
  type: OfflineJobType;
  createdAt: string;
  details: any;
  lots: any;
  attempts: number;
  nextAttemptAt?: number;
  fileUris: string[];
  ownedDraftId?: string;
  lastError?: string;
  lastErrorKind?: 'network' | 'transient_server' | 'validation' | 'auth' | 'files' | 'unknown';
  lastAttemptAt?: string;
};

export type OfflineQueueRetryResult = {
  status: 'submitted' | 'waiting' | 'needs_attention';
  message: string;
};

class OfflineQueueFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineQueueFileError';
  }
}

const QUEUE_KEY = '@clearvalue_offline_submit_queue_v1';
const getOfflineQueueDir = (): string => `${FileSystem.documentDirectory || ''}offline_submit_queue/`;

let didInit = false;
let processing = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let networkSub: (() => void) | null = null;
const listeners = new Set<(jobs: OfflineQueueJob[]) => void>();

async function ensureQueueDirExists(): Promise<void> {
  const dir = getOfflineQueueDir();
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

function getExtFromNameOrUri(name?: string, uri?: string): string {
  const raw = name || uri || '';
  const match = /\.([a-zA-Z0-9]+)(\?|#|$)/.exec(raw);
  if (!match) return '';
  return match[1].toLowerCase();
}

function guessMimeTypeFromExt(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function buildUriCandidates(sourceUri: string): string[] {
  const candidates = [
    sourceUri,
    sourceUri.startsWith('file://') ? sourceUri.replace(/^file:\/\//, '') : `file://${sourceUri}`,
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveExistingUri(sourceUri: string): Promise<string> {
  for (const candidate of buildUriCandidates(sourceUri)) {
    try {
      const info = await FileSystem.getInfoAsync(candidate);
      if (info.exists) return candidate;
    } catch {
      // Try the next URI form.
    }
  }

  throw new OfflineQueueFileError('One or more selected photos are no longer available on this device.');
}

async function copyFileToQueue(sourceUri: string, filename: string): Promise<string> {
  await ensureQueueDirExists();
  const destUri = `${getOfflineQueueDir()}${filename}`;

  const existingSourceUri = await resolveExistingUri(sourceUri);

  await FileSystem.copyAsync({ from: existingSourceUri, to: destUri });
  return destUri;
}

async function persistFileForQueue(args: {
  sourceUri: string;
  filename: string;
  sourceDraftId?: string;
  lotId: string;
  slot: 'main' | 'extra' | 'video';
  index: number;
  name?: string;
  type?: string;
}): Promise<string> {
  if (args.sourceDraftId) {
    const imported = await LocalMediaStore.importMedia({
      draftId: args.sourceDraftId,
      lotId: args.lotId,
      slot: args.slot,
      index: args.index,
      sourceUri: args.sourceUri,
      name: args.name,
      type: args.type,
    });
    if (!imported?.uri) {
      throw new OfflineQueueFileError('One or more selected photos are no longer available on this device.');
    }
    return imported.uri;
  }

  return copyFileToQueue(args.sourceUri, args.filename);
}

async function deleteLocalFile(uri: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // ignore
  }
}

async function loadQueue(): Promise<OfflineQueueJob[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: OfflineQueueJob[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  listeners.forEach((listener) => listener(queue));
}

function computeBackoffMs(attempts: number): number {
  const base = 5_000;
  const max = 5 * 60_000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  return exp;
}

function retryableUploadMessage(): string {
  return 'Upload paused because the internet connection was interrupted. It will retry automatically when the connection returns, or you can tap Send.';
}

async function isOnline(): Promise<boolean> {
  return (await getConnectivityStatus()).status === 'online';
}

async function enqueueJob(job: Omit<OfflineQueueJob, 'attempts'>): Promise<void> {
  const queue = await loadQueue();
  const submissionId = String(job.details?.client_submission_id || '').trim();
  if (
    submissionId &&
    queue.some(
      (queued) =>
        queued.type === job.type &&
        String(queued.details?.client_submission_id || '').trim() === submissionId
    )
  ) {
    return;
  }
  queue.push({ ...job, attempts: 0 });
  await saveQueue(queue);
}

async function persistAssetLots(
  lots: AssetMixedLot[],
  jobId: string,
  options: { sourceDraftId?: string } = {}
): Promise<{ lots: AssetMixedLot[]; fileUris: string[] }> {
  const fileUris: string[] = [];
  const missing: string[] = [];

  const persistedLots: AssetMixedLot[] = [];
  for (let lotIndex = 0; lotIndex < lots.length; lotIndex++) {
    const lot = lots[lotIndex];

    const newFiles: AssetMixedLot['files'] = [];
    for (let i = 0; i < (lot.files ?? []).length; i++) {
      const f = lot.files[i];
      const ext = getExtFromNameOrUri(f?.name, f?.uri) || 'jpg';
      const name = `asset_${jobId}_lot${lotIndex + 1}_main_${i}.${ext}`;
      try {
        const dest = await persistFileForQueue({
          sourceUri: f.uri,
          filename: name,
          sourceDraftId: options.sourceDraftId,
          lotId: lot.id || `lot-${lotIndex + 1}`,
          slot: 'main',
          index: i,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
        });
        fileUris.push(dest);
        newFiles.push({
          uri: dest,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
          captureOrder: (f as any)?.captureOrder,
          originalOrder: (f as any)?.originalOrder,
        } as any);
      } catch {
        missing.push(`Lot ${lotIndex + 1} main image ${i + 1}`);
      }
    }

    const newExtra: AssetMixedLot['extraFiles'] = [];
    for (let i = 0; i < (lot.extraFiles ?? []).length; i++) {
      const f = lot.extraFiles[i];
      const ext = getExtFromNameOrUri(f?.name, f?.uri) || 'jpg';
      const name = `asset_${jobId}_lot${lotIndex + 1}_extra_${i}.${ext}`;
      try {
        const dest = await persistFileForQueue({
          sourceUri: f.uri,
          filename: name,
          sourceDraftId: options.sourceDraftId,
          lotId: lot.id || `lot-${lotIndex + 1}`,
          slot: 'extra',
          index: i,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
        });
        fileUris.push(dest);
        newExtra.push({
          uri: dest,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
          captureOrder: (f as any)?.captureOrder,
          originalOrder: (f as any)?.originalOrder,
        } as any);
      } catch {
        missing.push(`Lot ${lotIndex + 1} extra image ${i + 1}`);
      }
    }

    let newVideoFile: AssetMixedLot['videoFile'] | undefined;
    if (lot.videoFile?.uri) {
      const ext = getExtFromNameOrUri(lot.videoFile?.name, lot.videoFile?.uri) || 'mp4';
      const name = `asset_${jobId}_lot${lotIndex + 1}_video.${ext}`;
      try {
        const dest = await persistFileForQueue({
          sourceUri: lot.videoFile.uri,
          filename: name,
          sourceDraftId: options.sourceDraftId,
          lotId: lot.id || `lot-${lotIndex + 1}`,
          slot: 'video',
          index: 0,
          name: lot.videoFile?.name || name,
          type: lot.videoFile?.type || guessMimeTypeFromExt(ext),
        });
        fileUris.push(dest);
        newVideoFile = {
          uri: dest,
          name: lot.videoFile?.name || name,
          type: lot.videoFile?.type || guessMimeTypeFromExt(ext),
        };
      } catch {
        missing.push(`Lot ${lotIndex + 1} video`);
      }
    }

    persistedLots.push({
      ...lot,
      files: newFiles,
      extraFiles: newExtra,
      videoFile: newVideoFile,
    });
  }

  if (missing.length > 0) {
    throw new OfflineQueueFileError(
      `Offline save stopped because ${missing.length} file${missing.length === 1 ? '' : 's'} could not be copied. ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}. ` +
        'Please reopen the draft and re-add the missing photos before uploading.'
    );
  }

  return { lots: persistedLots, fileUris };
}

async function persistLotListingLots(
  lots: LotListingLot[],
  jobId: string,
  options: { sourceDraftId?: string } = {}
): Promise<{ lots: LotListingLot[]; fileUris: string[] }> {
  const fileUris: string[] = [];
  const missing: string[] = [];

  const persistedLots: LotListingLot[] = [];
  for (let lotIndex = 0; lotIndex < lots.length; lotIndex++) {
    const lot = lots[lotIndex];

    const newFiles: LotListingLot['files'] = [];
    for (let i = 0; i < (lot.files ?? []).length; i++) {
      const f = lot.files[i];
      const ext = getExtFromNameOrUri(f?.name, f?.uri) || 'jpg';
      const name = `lotlisting_${jobId}_lot${lotIndex + 1}_main_${i}.${ext}`;
      try {
        const dest = await persistFileForQueue({
          sourceUri: f.uri,
          filename: name,
          sourceDraftId: options.sourceDraftId,
          lotId: lot.id || `lot-${lotIndex + 1}`,
          slot: 'main',
          index: i,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
        });
        fileUris.push(dest);
        newFiles.push({
          uri: dest,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
          captureOrder: (f as any)?.captureOrder,
          originalOrder: (f as any)?.originalOrder,
        } as any);
      } catch {
        missing.push(`Lot ${lotIndex + 1} main image ${i + 1}`);
      }
    }

    const extraFiles = lot.extraFiles ?? [];
    const newExtra: LotListingLot['extraFiles'] = [];
    for (let i = 0; i < extraFiles.length; i++) {
      const f = extraFiles[i];
      const ext = getExtFromNameOrUri(f?.name, f?.uri) || 'jpg';
      const name = `lotlisting_${jobId}_lot${lotIndex + 1}_extra_${i}.${ext}`;
      try {
        const dest = await persistFileForQueue({
          sourceUri: f.uri,
          filename: name,
          sourceDraftId: options.sourceDraftId,
          lotId: lot.id || `lot-${lotIndex + 1}`,
          slot: 'extra',
          index: i,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
        });
        fileUris.push(dest);
        newExtra.push({
          uri: dest,
          name: f?.name || name,
          type: f?.type || guessMimeTypeFromExt(ext),
          captureOrder: (f as any)?.captureOrder,
          originalOrder: (f as any)?.originalOrder,
        } as any);
      } catch {
        missing.push(`Lot ${lotIndex + 1} extra image ${i + 1}`);
      }
    }

    persistedLots.push({
      ...lot,
      files: newFiles,
      extraFiles: newExtra,
    });
  }

  if (missing.length > 0) {
    throw new OfflineQueueFileError(
      `Offline save stopped because ${missing.length} file${missing.length === 1 ? '' : 's'} could not be copied. ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}. ` +
        'Please reopen the draft and re-add the missing photos before uploading.'
    );
  }

  return { lots: persistedLots, fileUris };
}

async function assertQueuedFilesExist(job: OfflineQueueJob): Promise<void> {
  const missing: string[] = [];
  for (const uri of job.fileUris ?? []) {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) missing.push(uri);
    } catch {
      missing.push(uri);
    }
  }

  if (missing.length > 0) {
    throw new OfflineQueueFileError(
      `Offline upload cannot be sent because ${missing.length} queued file${missing.length === 1 ? '' : 's'} are missing.`
    );
  }
}

async function submitJob(job: OfflineQueueJob): Promise<void> {
  await assertQueuedFilesExist(job);

  if (job.type === 'asset') {
    await assetService.createAssetReport(job.details as AssetCreateDetails, job.lots as AssetMixedLot[]);
    return;
  }

  if (job.type === 'lotListing') {
    await lotListingService.createLotListing(job.details as LotListingDetails, job.lots as LotListingLot[]);
    return;
  }
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const queue = await loadQueue();
    if (queue.length === 0) return;

    if (!(await isOnline())) return;

    const now = Date.now();
    const updated: OfflineQueueJob[] = [];

    for (const job of queue) {
      if (typeof job.nextAttemptAt === 'number' && job.nextAttemptAt > now) {
        updated.push(job);
        continue;
      }

      try {
        await submitJob(job);

        for (const uri of job.fileUris ?? []) {
          await deleteLocalFile(uri);
        }
        if (job.ownedDraftId) {
          await AutoSaveService.deleteDraftMedia(job.ownedDraftId);
        }
        await AutoSaveService.cleanupOrphanedMedia(
          queue
            .filter((queuedJob) => queuedJob.id !== job.id)
            .flatMap((queuedJob) => queuedJob.fileUris || []),
          0
        ).catch(() => undefined);

        const label = job.type === 'asset' ? 'Asset Report' : 'Lot Listing';
        Alert.alert(
          'Offline Upload Sent',
          `Your ${label} saved on ${new Date(job.createdAt).toLocaleString()} was uploaded successfully. Processing continues in the background.`
        );
      } catch (e: any) {
        const attempts = (job.attempts ?? 0) + 1;
        const isFileError = e instanceof OfflineQueueFileError;
        const status = getErrorStatus(e);
        const isNetworkError = isNetworkTransportError(e);
        const isTransientServerError = Boolean(status && isRetryableRequestError(e));
        const isAuthError = status === 401 || status === 403;
        const isValidationError = Boolean(
          status && status >= 400 && status < 500 && !isAuthError && !isTransientServerError
        );
        const errorKind: OfflineQueueJob['lastErrorKind'] = isFileError
          ? 'files'
          : isNetworkError
            ? 'network'
            : isTransientServerError
              ? 'transient_server'
              : isAuthError
                ? 'auth'
                : isValidationError
                  ? 'validation'
                  : 'unknown';
        const retryable = isNetworkError || isTransientServerError;
        const backoffMs = isFileError || isAuthError || isValidationError
          ? 24 * 60 * 60_000
          : retryable
            ? 30_000
            : computeBackoffMs(attempts);
        const nextAttemptAt = Date.now() + backoffMs;
        const msg = isNetworkError
          ? retryableUploadMessage()
          : isTransientServerError
            ? 'The server is temporarily unavailable. This upload remains safe and will retry automatically.'
            : getSubmissionError(e).message;

        if (!retryable && job.lastError !== msg) {
          Alert.alert(
            'Offline Upload Needs Attention',
            `${msg} This upload was not sent, and no partial report was created.`
          );
        }

        updated.push({
          ...job,
          attempts,
          nextAttemptAt,
          lastError: msg,
          lastErrorKind: errorKind,
          lastAttemptAt: new Date().toISOString(),
        });
      }
    }

    await saveQueue(updated);
  } finally {
    processing = false;
  }
}

function startSyncLoop(): void {
  if (syncInterval) return;
  syncInterval = setInterval(() => {
    void processQueue();
  }, Platform.OS === 'android' ? 20_000 : 25_000);
}

function stopSyncLoop(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

function onAppStateChange(next: AppStateStatus) {
  if (next === 'active') {
    void loadQueue().then((queue) =>
      AutoSaveService.cleanupOrphanedMedia(queue.flatMap((job) => job.fileUris || [])).catch(() => undefined)
    );
    void processQueue();
  }
}

async function waitForQueueIdle(timeoutMs = 10 * 60_000): Promise<void> {
  const startedAt = Date.now();
  while (processing && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export const OfflineQueueService = {
  init(): void {
    if (didInit) return;
    didInit = true;

    startSyncLoop();
    void loadQueue().then((queue) =>
      AutoSaveService.cleanupOrphanedMedia(queue.flatMap((job) => job.fileUris || [])).catch(() => undefined)
    );
    void processQueue();

    appStateSub = AppState.addEventListener('change', onAppStateChange);
    networkSub = NetInfo.addEventListener((state) => {
      if (state.isConnected === true) {
        void processQueue();
      }
    });
  },

  cleanup(): void {
    stopSyncLoop();
    appStateSub?.remove();
    appStateSub = null;
    networkSub?.();
    networkSub = null;
    didInit = false;
  },

  async isOnline(): Promise<boolean> {
    return isOnline();
  },

  async getConnectivityStatus(): Promise<ConnectivityResult> {
    return getConnectivityStatus();
  },

  isNetworkError(error: any): boolean {
    return isNetworkTransportError(error);
  },

  async shouldQueueAfterError(error: any): Promise<boolean> {
    return shouldQueueAfterError(error);
  },

  getSubmissionError(error: any): { title: string; message: string } {
    return getSubmissionError(error);
  },

  async enqueueAssetReport(
    details: AssetCreateDetails,
    lots: AssetMixedLot[],
    options: { sourceDraftId?: string } = {}
  ): Promise<{ id: string; resumed: boolean }> {
    const submissionId = String(details.client_submission_id || '').trim();
    if (submissionId) {
      const existing = (await loadQueue()).find(
        (job) =>
          job.type === 'asset' &&
          String(job.details?.client_submission_id || '').trim() === submissionId
      );
      if (existing) return { id: existing.id, resumed: true };
    }
    const id = `asset-offline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const persisted = await persistAssetLots(lots, id, options);

    const mixedLots = persisted.lots.map((lot) => ({
      count: (lot.files ?? []).length,
      extra_count: (lot.extraFiles ?? []).length,
      cover_index: lot.coverIndex || 0,
      mode: lot.mode || 'single_lot',
    }));

    await enqueueJob({
      id,
      type: 'asset',
      createdAt: new Date().toISOString(),
      details: {
        ...details,
        include_damage_analysis: details.include_damage_analysis !== false,
        valuation_methods: details.valuation_methods?.length ? details.valuation_methods : ['FML'],
        mixed_lots: mixedLots,
      },
      lots: persisted.lots,
      fileUris: persisted.fileUris,
      ownedDraftId: options.sourceDraftId,
    });
    return { id, resumed: false };
  },

  async enqueueLotListing(
    details: LotListingDetails,
    lots: LotListingLot[],
    options: { sourceDraftId?: string } = {}
  ): Promise<{ id: string; resumed: boolean }> {
    const submissionId = String(details.client_submission_id || '').trim();
    if (submissionId) {
      const existing = (await loadQueue()).find(
        (job) =>
          job.type === 'lotListing' &&
          String(job.details?.client_submission_id || '').trim() === submissionId
      );
      if (existing) return { id: existing.id, resumed: true };
    }
    const id = `lotlisting-offline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const persisted = await persistLotListingLots(lots, id, options);

    const mixedLots = persisted.lots.map((lot) => ({
      count: (lot.files ?? []).length,
      extra_count: (lot.extraFiles ?? []).length,
      cover_index: lot.coverIndex || 0,
      mode: lot.mode || 'single_lot',
    }));

    await enqueueJob({
      id,
      type: 'lotListing',
      createdAt: new Date().toISOString(),
      details: {
        ...details,
        include_damage_analysis: details.include_damage_analysis !== false,
        valuation_methods: details.valuation_methods?.length ? details.valuation_methods : ['FML'],
        mixed_lots: mixedLots,
      },
      lots: persisted.lots,
      fileUris: persisted.fileUris,
      ownedDraftId: options.sourceDraftId,
    });
    return { id, resumed: false };
  },

  async getPendingCount(): Promise<number> {
    const q = await loadQueue();
    return q.length;
  },

  async getJobs(): Promise<OfflineQueueJob[]> {
    const q = await loadQueue();
    return q.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  subscribe(listener: (jobs: OfflineQueueJob[]) => void): () => void {
    listeners.add(listener);
    void loadQueue().then((jobs) => listener(jobs));
    return () => {
      listeners.delete(listener);
    };
  },

  async deleteJob(id: string): Promise<void> {
    const q = await loadQueue();
    const job = q.find((item) => item.id === id);
    if (job) {
      for (const uri of job.fileUris ?? []) {
        await deleteLocalFile(uri);
      }
      if (job.ownedDraftId) {
        await AutoSaveService.deleteDraftMedia(job.ownedDraftId);
      }
    }
    await saveQueue(q.filter((item) => item.id !== id));
  },

  async retryJob(id: string): Promise<OfflineQueueRetryResult> {
    await waitForQueueIdle();
    const q = await loadQueue();
    await saveQueue(
      q.map((job) =>
        job.id === id
          ? {
              ...job,
              nextAttemptAt: undefined,
            }
          : job
      )
    );
    await processQueue();
    const remaining = (await loadQueue()).find((job) => job.id === id);
    if (!remaining) {
      return {
        status: 'submitted',
        message: 'Upload complete. The report is now processing in the background.',
      };
    }
    const recoverable =
      remaining.lastErrorKind === 'network' || remaining.lastErrorKind === 'transient_server';
    return {
      status: recoverable || !remaining.lastError ? 'waiting' : 'needs_attention',
      message:
        remaining.lastError ||
        'This report is still waiting for a confirmed internet connection.',
    };
  },

  async retryAll(): Promise<void> {
    const q = await loadQueue();
    await saveQueue(q.map((job) => ({ ...job, nextAttemptAt: undefined })));
    await processQueue();
  },

  async forceSyncOnce(): Promise<void> {
    await processQueue();
  },

  async clearAllJobs(): Promise<void> {
    const q = await loadQueue();
    for (const job of q) {
      for (const uri of job.fileUris ?? []) {
        await deleteLocalFile(uri);
      }
      if (job.ownedDraftId) {
        await AutoSaveService.deleteDraftMedia(job.ownedDraftId);
      }
    }
    await saveQueue([]);
  },
};

export default OfflineQueueService;
