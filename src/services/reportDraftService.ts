import api from './api';
import { allowsCloudDraft } from './offlineDraftPolicy';
import OfflineCaptureStore from './offlineCaptureStore';
import { isRetryableRequestError } from './connectivityService';
import { createUploadOperation, cancellableUploadRequest } from './uploadCancellation';
import type {
  AutoSaveFormData,
  OfflineDraftType,
  OfflineReportDraft,
  SavedLotData,
  SavedPhotoFileData,
  SavedVideoFileData,
} from './autoSaveService';
import {
  uploadLocalFileToPresignedUrl,
  type DirectUploadFile,
} from './directR2UploadService';

export type CloudDraftMedia = {
  clientFileId: string;
  localKey?: string;
  mediaId?: string;
  lotId: string;
  slot: 'main' | 'extra' | 'video';
  index: number;
  captureOrder?: number;
  originalOrder?: number;
  name?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  verifiedSize?: number;
  lastModified?: number;
  r2Key?: string;
  uploadedAt?: string;
};

export const DUPLICATE_LOT_DETECTED = 'DUPLICATE_LOT_DETECTED';

export type DuplicateLotConflict = {
  contractNo?: string;
  lotNumber?: string;
  sourceType?: string;
  sourceId?: string;
  ownerDisplay?: string;
  message?: string;
};

export type ReportDraft = {
  _id?: string;
  id: string;
  clientDraftId?: string;
  type: OfflineDraftType;
  storageMode?: 'local_media' | 'r2_media' | 'smart_upload';
  revision?: number;
  contractNo: string;
  normalizedContractNo: string;
  title: string;
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  media?: CloudDraftMedia[];
  previewStatus?: 'idle' | 'queued' | 'processing' | 'ready' | 'error';
  previewReportId?: string;
  previewJobId?: string;
  previewRequestedRevision?: number;
  previewProcessedRevision?: number;
  previewError?: string;
  previewRequestedAt?: string;
  previewReadyAt?: string;
  duplicateLotConflicts?: DuplicateLotConflict[];
  syncWarningCode?: string;
  syncWarningMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/** Reads the stable server warning from either a saved draft or an API error. */
export function getDuplicateLotWarning(value: unknown): string | null {
  const candidate = value as any;
  const payload = candidate?.response?.data || candidate;
  const code = String(payload?.code || payload?.syncWarningCode || '').trim();
  if (code !== DUPLICATE_LOT_DETECTED) return null;
  return String(
    payload?.message ||
      payload?.syncWarningMessage ||
      'This contract already contains the same lot number. Change the lot number before creating the preview.'
  );
}

type DraftMediaEntry = {
  descriptor: CloudDraftMedia;
  file?: DirectUploadFile;
};

type DraftUploadTarget = {
  clientFileId: string;
  r2Key: string;
  uploadUrl?: string;
  url?: string;
  alreadyUploaded: boolean;
};

const TARGET_BATCH_SIZE = 200;
const MULTIPART_BATCH_SIZE = 10;
const UPLOAD_CONCURRENCY = 4;

const normalizeContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const chunks = <T,>(items: T[], size: number) => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
};

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, items.length), concurrency) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    })
  );
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function preferredUri(value: any) {
  if (typeof value === 'string') return value;
  return String(
    value?.originalUri ||
      value?.sourceUri ||
      value?.cacheUri ||
      value?.editedUri ||
      value?.displayUri ||
      value?.uri ||
      ''
  );
}

function stableMediaId(
  draft: OfflineReportDraft,
  value: any,
  lotId: string,
  slot: CloudDraftMedia['slot'],
  fallbackName: string
) {
  if (typeof value !== 'string') {
    const stored = String(
      value?.clientFileId || value?.mediaId || value?.localKey || ''
    ).trim();
    if (stored) return stored;
  }
  const uri = preferredUri(value);
  const name = typeof value === 'string' ? fallbackName : value?.name || fallbackName;
  const timestamp = typeof value === 'string' ? '' : value?.timestamp || value?.createdAt || '';
  return `mobile-${stableHash(`${draft.id}|${lotId}|${slot}|${uri}|${name}|${timestamp}`)}`;
}

function isUploadableLocalUri(uri?: string) {
  return Boolean(uri && !/^https?:\/\//i.test(uri));
}

function buildDraftEntries(draft: OfflineReportDraft): DraftMediaEntry[] {
  const entries: DraftMediaEntry[] = [];
  let originalOrder = 0;

  const append = (
    value: SavedPhotoFileData | SavedVideoFileData | string,
    lotId: string,
    slot: CloudDraftMedia['slot'],
    index: number,
    fallbackName: string,
    fallbackType: string
  ) => {
    const source: any = typeof value === 'string' ? {} : value;
    const uri = preferredUri(value);
    const clientFileId = stableMediaId(draft, value, lotId, slot, fallbackName);
    const name = String(source.name || fallbackName);
    const mimeType = String(source.type || fallbackType);
    const descriptor: CloudDraftMedia = {
      clientFileId,
      localKey: clientFileId,
      mediaId: String(source.mediaId || clientFileId),
      lotId,
      slot,
      index,
      captureOrder: Number.isFinite(Number(source.captureOrder))
        ? Number(source.captureOrder)
        : index,
      originalOrder,
      name,
      mimeType,
      size: Number(source.size || 0),
      lastModified: Number(source.lastModified || source.timestamp || 0),
    };
    entries.push({
      descriptor,
      ...(isUploadableLocalUri(uri)
        ? {
            file: {
              uri,
              name,
              type: mimeType,
              size: descriptor.size,
              fieldname: slot === 'video' ? 'videos' : 'images',
              role: slot,
              imageIndex: index,
              captureOrder: descriptor.captureOrder,
              originalOrder,
            },
          }
        : {}),
    });
    originalOrder += 1;
  };

  draft.lots.forEach((lot, lotIndex) => {
    const lotId = String(lot.id || `draft-lot-${lotIndex + 1}`);
    lot.mainImages.forEach((value, index) =>
      append(value, lotId, 'main', index, `${lotId}-main-${index + 1}.jpg`, 'image/jpeg')
    );
    lot.extraImages.forEach((value, index) =>
      append(value, lotId, 'extra', index, `${lotId}-extra-${index + 1}.jpg`, 'image/jpeg')
    );
    (lot.videoFiles || []).forEach((value, index) =>
      append(value, lotId, 'video', index, `${lotId}-video-${index + 1}.mp4`, 'video/mp4')
    );
  });
  return entries;
}

/** Text and lot settings live in Mongo; media bytes are represented only by the R2 manifest. */
function serializeLots(lots: SavedLotData[]): SavedLotData[] {
  return lots.map((lot, index) => ({
    ...lot,
    id: String(lot.id || `draft-lot-${index + 1}`),
    mainImages: [],
    extraImages: [],
    videoFiles: [],
  }));
}

function isConfirmedDraftEntry(entry: DraftMediaEntry, media: CloudDraftMedia[]) {
  const expected = entry.descriptor;
  const saved = media.find((item) => item.clientFileId === expected.clientFileId);
  if (!saved?.uploadedAt || !saved.url) return false;
  // A response may have been lost after the multipart batch committed. Only
  // matching saved identities/metadata can establish that this batch succeeded.
  const fields = ['lotId', 'slot', 'index', 'originalOrder', 'name', 'mimeType', 'lastModified'] as const;
  return fields.every((field) => saved[field] === expected[field]) &&
    (!expected.size || Number(saved.verifiedSize ?? saved.size) === expected.size);
}

const reportDraftService = {
  async list(): Promise<ReportDraft[]> {
    const response = await api.get<{ message: string; data: ReportDraft[] }>('/report-drafts');
    return response.data.data || [];
  },

  async get(id: string): Promise<ReportDraft> {
    const response = await api.get<{ message: string; data: ReportDraft }>(`/report-drafts/${id}`);
    return response.data.data;
  },

  async processPreview(id: string): Promise<ReportDraft> {
    const response = await api.post<{ message: string; data: ReportDraft }>(
      `/report-drafts/${encodeURIComponent(id)}/process-preview`
    );
    return response.data.data;
  },

  async upsertFromLocalDraft(draft: OfflineReportDraft): Promise<ReportDraft> {
    const operation = createUploadOperation();
    const assertAllowed = () => {
      operation.assertActive();
      if (!allowsCloudDraft(draft)) throw new Error('Offline captures save only on this device. Use Submit when you are ready to upload.');
      if (!draft.ownerId || draft.ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('Sign in to the account that owns this draft.');
    };
    assertAllowed();
    const entries = buildDraftEntries(draft);
    const response = await cancellableUploadRequest(operation, (signal) => api.post<{
      message: string;
      code?: string;
      warning?: boolean;
      conflicts?: DuplicateLotConflict[];
      data: ReportDraft;
    }>('/report-drafts', {
      clientDraftId: draft.id,
      type: draft.type,
      storageMode: 'r2_media',
      revision: Date.now(),
      contractNo: draft.contractNo || draft.formData.contractNo,
      normalizedContractNo:
        draft.normalizedContractNo || normalizeContractNo(draft.contractNo || draft.formData.contractNo),
      title: draft.title,
      formData: draft.formData,
      lots: serializeLots(draft.lots),
      activeLotIdx: draft.activeLotIdx,
      media: entries.map((entry) => entry.descriptor),
    }, { signal }));
    const syncWarningCode = response.data.code;
    assertAllowed();
    const syncWarningMessage = syncWarningCode ? response.data.message : undefined;
    const duplicateLotConflicts = response.data.conflicts || [];
    let cloud: ReportDraft = {
      ...response.data.data,
      duplicateLotConflicts,
      syncWarningCode,
      syncWarningMessage,
    };
    const draftId = cloud.id || cloud._id;
    if (!draftId || entries.length === 0) return cloud;

    const savedIds = new Set(
      (cloud.media || [])
        .filter((item) => item.url && item.uploadedAt)
        .map((item) => item.clientFileId)
    );
    const pending = entries.filter((entry) => !savedIds.has(entry.descriptor.clientFileId));

    for (const batch of chunks(pending, TARGET_BATCH_SIZE)) {
      assertAllowed();
      const targetResponse = await cancellableUploadRequest(operation, (signal) => api.post<{ message: string; data: DraftUploadTarget[] }>(
        `/report-drafts/${draftId}/media/targets`,
        { media: batch.map((entry) => entry.descriptor) },
        { timeout: 60000, signal }
      ));
      const targetById = new Map(
        (targetResponse.data.data || []).map((target) => [target.clientFileId, target])
      );
      const confirmed: string[] = [];
      const multipart: DraftMediaEntry[] = [];

      await mapWithConcurrency(batch, UPLOAD_CONCURRENCY, async (entry) => {
        assertAllowed();
        const target = targetById.get(entry.descriptor.clientFileId);
        if (!target) throw new Error(`No storage target was returned for ${entry.descriptor.name}.`);
        if (target.alreadyUploaded) return;
        if (!entry.file) {
          throw new Error(
            `${entry.descriptor.name || 'Draft media'} is unavailable on this device and was not found in cloud storage.`
          );
        }
        if (!target.uploadUrl) {
          // Draft direct PUTs are optional on the server. The authenticated
          // multipart route persists the same media identities when disabled.
          multipart.push(entry);
          return;
        }
        await uploadLocalFileToPresignedUrl(
          entry.file,
          target.uploadUrl,
          entry.descriptor.mimeType
        );
        confirmed.push(entry.descriptor.clientFileId);
      });

      for (const idBatch of chunks(confirmed, TARGET_BATCH_SIZE)) {
        assertAllowed();
        if (!idBatch.length) continue;
        await cancellableUploadRequest(operation, (signal) => api.post(
          `/report-drafts/${draftId}/media/confirm`,
          { clientFileIds: idBatch },
          { timeout: 120000, signal }
        ));
      }

      for (const mediaBatch of chunks(multipart, MULTIPART_BATCH_SIZE)) {
        assertAllowed();
        const body = new FormData();
        body.append('replace', 'false');
        body.append('metadata', JSON.stringify(mediaBatch.map((entry) => entry.descriptor)));
        mediaBatch.forEach((entry) => body.append('files', {
          uri: entry.file!.uri,
          name: entry.file!.name,
          type: entry.file!.type,
        } as any));
        try {
          await cancellableUploadRequest(operation, (signal) => api.post(
            `/report-drafts/${encodeURIComponent(draftId)}/media`,
            body,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000, signal }
          ));
          assertAllowed();
        } catch (error) {
          assertAllowed();
          if (!isRetryableRequestError(error)) throw error;
          // Multipart writes allocate fresh object keys. Never replay an
          // uncertain batch: read the same draft before proceeding or retrying.
          let savedMedia: CloudDraftMedia[] = [];
          try {
            const saved = await cancellableUploadRequest(operation, (signal) => api.get<{ data: ReportDraft }>(
              `/report-drafts/${encodeURIComponent(draftId)}`, { signal }
            ));
            assertAllowed();
            savedMedia = saved.data.data.media || [];
          } catch {
            assertAllowed();
            throw error;
          }
          if (!mediaBatch.every((entry) => isConfirmedDraftEntry(entry, savedMedia))) throw error;
        }
      }
    }

    assertAllowed();
    const refreshed = await cancellableUploadRequest(operation, (signal) => api.get<{ data: ReportDraft }>(`/report-drafts/${encodeURIComponent(draftId)}`, { signal }));
    cloud = {
      ...refreshed.data.data,
      duplicateLotConflicts,
      syncWarningCode,
      syncWarningMessage,
    };
    const savedById = new Map((cloud.media || []).map((item) => [item.clientFileId, item]));
    const missing = entries.filter((entry) => {
      const item = savedById.get(entry.descriptor.clientFileId);
      return !item?.uploadedAt || !item.url;
    });
    if (missing.length) {
      throw new Error(
        `${missing.length} draft media file${missing.length === 1 ? '' : 's'} could not be verified in cloud storage.`
      );
    }
    return cloud;
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/report-drafts/${id}`);
  },
};

export default reportDraftService;
