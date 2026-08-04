import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import type { PhotoFile } from '../components/camera/types';
import { ImageEditService } from './imageEditService';
import {
  getPhotoOriginalUri,
  normalizeImageAdjustments,
  normalizePhotoFile,
} from '../utils/photoFileUtils';
import { LocalMediaStore } from './localMediaStore';

const AUTO_SAVE_KEY = '@clearvalue_auto_save';
const DRAFTS_KEY = '@clearvalue_offline_report_drafts_v1';
const LEGACY_MIGRATED_KEY = '@clearvalue_auto_save_migrated_to_drafts_v1';
const getAutoSaveImagesDir = (): string => `${FileSystem.documentDirectory || ''}auto_save_images/`;
const getLegacyDraftImagesDir = (draftId: string): string =>
  `${FileSystem.documentDirectory || ''}offline_report_drafts/${draftId}/`;
const getDraftImagesDir = (draftId: string): string =>
  LocalMediaStore.getDraftDir(draftId);

type SavedVideoFileData = {
  uri: string;
  name: string;
  type: string;
  mediaId?: string;
  sourceUri?: string;
  size?: number;
  lotId?: string;
  slot?: 'video';
  index?: number;
  createdAt?: string;
};

export interface SavedPhotoFileData {
  uri: string;
  originalUri?: string;
  editedUri?: string;
  displayUri?: string;
  thumbnailUri?: string;
  name: string;
  type: string;
  mediaId?: string;
  sourceUri?: string;
  cacheUri?: string;
  size?: number;
  lotId?: string;
  slot?: 'main' | 'extra';
  index?: number;
  createdAt?: string;
  width?: number;
  height?: number;
  megapixels?: number;
  focusBox?: { x: number; y: number; w: number; h: number };
  adjustments?: PhotoFile['adjustments'];
  timestamp?: number;
  captureOrder?: number;
  originalOrder?: number;
}

export interface SavedLotData {
  id: string;
  mode?: 'single_lot' | 'per_item' | 'per_photo';
  mainImages: (SavedPhotoFileData | string)[];
  extraImages: (SavedPhotoFileData | string)[];
  videoFiles: (SavedVideoFileData | string)[];
  coverIndex: number;
}

export interface AutoSaveFormData {
  clientSubmissionId?: string;
  clientName?: string;
  effectiveDate?: string;
  appraisalPurpose?: string;
  ownerName?: string;
  appraiser?: string;
  appraisalCompany?: string;
  industry?: string;
  inspectionDate?: string;
  contractNo?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  salesDate?: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string;
  preparedFor?: string;
  factorsAgeCondition?: string;
  factorsQuality?: string;
  factorsAnalysis?: string;
  includeDamageAnalysis?: boolean;
  bankPhotosEnabled?: boolean;
  includeValuationTable?: boolean;
  selectedValuationMethods?: ('FML' | 'TKV' | 'OLV' | 'FLV')[];
}

export interface AutoSaveData {
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  savedAt: string;
  formType: 'asset' | 'realEstate' | 'lotListing';
}

export type OfflineDraftType = 'asset' | 'lotListing';

export interface OfflineReportDraft {
  id: string;
  type: OfflineDraftType;
  title: string;
  contractNo?: string;
  normalizedContractNo?: string;
  cloudId?: string;
  cloudSyncedAt?: string;
  cloudSyncError?: string;
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  createdAt: string;
  updatedAt: string;
}

type AutoSaveLotInput = {
  id: string;
  mode?: 'single_lot' | 'per_item' | 'per_photo';
  files: PhotoFile[];
  extraFiles: PhotoFile[];
  videoFile?: PhotoFile;
  videoFiles?: { uri: string; name?: string; type?: string }[];
  coverIndex: number;
};

const ensureDirectoryExistsAt = async (dir: string): Promise<void> => {
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
};

const ensureDirectoryExists = async (): Promise<void> => {
  await ensureDirectoryExistsAt(getAutoSaveImagesDir());
};

const getFileExtension = (nameOrUri?: string, fallback = 'jpg') => {
  const value = nameOrUri ?? '';
  const match = /\.([a-zA-Z0-9]+)(\?|#|$)/.exec(value);
  return match?.[1]?.toLowerCase() || fallback;
};

const generateFilename = (lotId: string, slot: string, index: number, ext: string) =>
  `${lotId}_${slot}_${index}_${Date.now()}.${ext}`;

const isUriInAutoSaveDir = (uri?: string | null) => Boolean(uri && uri.startsWith(getAutoSaveImagesDir()));

const shouldDeleteManagedUri = (uri?: string | null) =>
  Boolean(
    uri &&
      (isUriInAutoSaveDir(uri) ||
        LocalMediaStore.isManagedUri(uri) ||
        ImageEditService.isManagedEditedUri(uri))
  );

const ensureUriExists = async (uri?: string | null) => {
  if (!uri) return false;
  if (/^https?:\/\//i.test(uri)) return true;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists);
  } catch {
    return false;
  }
};

const copyToDirectory = async (
  sourceUri: string,
  filename: string,
  destinationDir: string
): Promise<string> => {
  await ensureDirectoryExistsAt(destinationDir);

  if (sourceUri.startsWith(destinationDir)) {
    return sourceUri;
  }

  const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
  if (!sourceInfo.exists) {
    console.warn(`[AutoSave] Source file does not exist: ${sourceUri}`);
    return '';
  }

  const destinationUri = `${destinationDir}${filename}`;
  await FileSystem.copyAsync({
    from: sourceUri,
    to: destinationUri,
  });

  return destinationUri;
};

const getFileSize = async (uri?: string | null): Promise<number | undefined> => {
  if (!uri || /^https?:\/\//i.test(uri)) return undefined;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : undefined;
  } catch {
    return undefined;
  }
};

const copyToAutoSaveDir = async (sourceUri: string, filename: string): Promise<string> =>
  copyToDirectory(sourceUri, filename, getAutoSaveImagesDir());

const deleteLocalFile = async (uri?: string | null): Promise<void> => {
  if (!uri || !shouldDeleteManagedUri(uri)) return;
  const targetUri: string = uri;

  try {
    const info = await FileSystem.getInfoAsync(targetUri);
    if (info.exists) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true });
    }
  } catch (error) {
    console.error('Error deleting local image:', error);
  }
};

const normalizeSavedPhotoFile = async (
  photo: SavedPhotoFileData | string,
  fallbackName: string
): Promise<SavedPhotoFileData | null> => {
  if (typeof photo === 'string') {
    if (!(await ensureUriExists(photo))) return null;

    return normalizePhotoFile({
      uri: photo,
      originalUri: photo,
      displayUri: photo,
      name: fallbackName,
      type: 'image/jpeg',
    }) as SavedPhotoFileData;
  }

  const originalUri = photo.originalUri ?? photo.uri;
  const originalExists = await ensureUriExists(originalUri);
  const editedExists = await ensureUriExists(photo.editedUri);
  const fallbackUri = originalExists ? originalUri : editedExists ? photo.editedUri : null;

  if (!fallbackUri) return null;

  return normalizePhotoFile({
    ...photo,
    uri: originalExists ? originalUri : fallbackUri,
    originalUri: originalExists ? originalUri : fallbackUri,
    editedUri: editedExists ? photo.editedUri : undefined,
    displayUri: editedExists ? photo.editedUri : fallbackUri,
    adjustments: normalizeImageAdjustments(photo.adjustments),
  }) as SavedPhotoFileData;
};

const normalizeSavedVideoFile = async (
  video: SavedVideoFileData | string,
  fallbackName: string
): Promise<SavedVideoFileData | null> => {
  if (typeof video === 'string') {
    if (!(await ensureUriExists(video))) return null;
    return { uri: video, name: fallbackName, type: 'video/mp4' };
  }

  if (!(await ensureUriExists(video.uri))) return null;
  return video;
};

const persistPhotoFile = async (
  photo: PhotoFile,
  lotId: string,
  slot: 'main' | 'extra',
  index: number,
  destinationDir: string = getAutoSaveImagesDir(),
  keepManagedEditedUri = true,
  existing?: SavedPhotoFileData | string | null,
  draftId?: string
): Promise<SavedPhotoFileData | null> => {
  const normalized = normalizePhotoFile(photo);
  const originalUri = getPhotoOriginalUri(normalized);
  const existingPhoto = typeof existing === 'string' ? null : existing;

  if (
    existingPhoto &&
    existingPhoto.sourceUri === originalUri &&
    (await ensureUriExists(existingPhoto.uri))
  ) {
    return normalizePhotoFile({
      ...existingPhoto,
      originalUri: existingPhoto.originalUri || existingPhoto.uri,
      displayUri: existingPhoto.editedUri || existingPhoto.displayUri || existingPhoto.uri,
      thumbnailUri: existingPhoto.thumbnailUri,
      adjustments: normalizeImageAdjustments(existingPhoto.adjustments),
      timestamp: normalized.timestamp ?? existingPhoto.timestamp,
      captureOrder: normalized.captureOrder ?? existingPhoto.captureOrder,
      originalOrder: normalized.originalOrder ?? existingPhoto.originalOrder,
    }) as SavedPhotoFileData;
  }

  if (draftId) {
    const imported = await LocalMediaStore.importMedia({
      draftId,
      lotId,
      slot,
      index,
      sourceUri: originalUri,
      name: normalized.name,
      type: normalized.type,
      mediaId: existingPhoto?.mediaId,
    });

    if (!imported) return null;

    let persistedEditedUri: string | undefined;
    if (normalized.editedUri && (await ensureUriExists(normalized.editedUri))) {
      persistedEditedUri = keepManagedEditedUri && ImageEditService.isManagedEditedUri(normalized.editedUri)
        ? normalized.editedUri
        : (
            await LocalMediaStore.importMedia({
              draftId,
              lotId,
              slot,
              index,
              sourceUri: normalized.editedUri,
              name: `${normalized.name || imported.name}-edited.jpg`,
              type: 'image/jpeg',
              mediaId: `${imported.mediaId}-edited`,
            })
          )?.uri;
    }

    return normalizePhotoFile({
      ...normalized,
      uri: imported.uri,
      originalUri: imported.uri,
      editedUri: persistedEditedUri,
      displayUri: persistedEditedUri ?? imported.thumbnailUri ?? imported.uri,
      thumbnailUri: imported.thumbnailUri,
      name: imported.name,
      type: imported.type,
      mediaId: imported.mediaId,
      sourceUri: originalUri,
      cacheUri: normalized.cacheUri,
      size: imported.size,
      lotId,
      slot,
      index,
      createdAt: existingPhoto?.createdAt || imported.createdAt,
      adjustments: normalizeImageAdjustments(normalized.adjustments),
    }) as SavedPhotoFileData;
  }

  const originalExt = getFileExtension(normalized.name || originalUri, 'jpg');
  const persistedOriginal = await copyToDirectory(
    originalUri,
    generateFilename(lotId, `${slot}_original`, index, originalExt),
    destinationDir
  );

  if (!persistedOriginal) return null;

  let persistedEditedUri: string | undefined;
  if (normalized.editedUri) {
    if (await ensureUriExists(normalized.editedUri)) {
      persistedEditedUri = keepManagedEditedUri && ImageEditService.isManagedEditedUri(normalized.editedUri)
        ? normalized.editedUri
        : await copyToDirectory(
            normalized.editedUri,
            generateFilename(lotId, `${slot}_edited`, index, 'jpg'),
            destinationDir
          );
    }
  }

  return normalizePhotoFile({
    ...normalized,
    uri: persistedOriginal,
    originalUri: persistedOriginal,
    editedUri: persistedEditedUri,
    displayUri: persistedEditedUri ?? persistedOriginal,
    sourceUri: originalUri,
    cacheUri: normalized.cacheUri,
    size: await getFileSize(persistedOriginal),
    lotId,
    slot,
    index,
    adjustments: normalizeImageAdjustments(normalized.adjustments),
  }) as SavedPhotoFileData;
};

const persistVideoFile = async (
  videoFile: { uri: string; name?: string; type?: string },
  lotId: string,
  index: number,
  destinationDir: string = getAutoSaveImagesDir(),
  existing?: SavedVideoFileData | string | null,
  draftId?: string
): Promise<SavedVideoFileData | null> => {
  const existingVideo = typeof existing === 'string' ? null : existing;
  if (
    existingVideo &&
    existingVideo.sourceUri === videoFile.uri &&
    (await ensureUriExists(existingVideo.uri))
  ) {
    return existingVideo;
  }

  if (draftId) {
    const imported = await LocalMediaStore.importMedia({
      draftId,
      lotId,
      slot: 'video',
      index,
      sourceUri: videoFile.uri,
      name: videoFile.name,
      type: videoFile.type || 'video/mp4',
      mediaId: existingVideo?.mediaId,
    });
    if (!imported) return null;
    return {
      uri: imported.uri,
      name: imported.name,
      type: imported.type,
      mediaId: imported.mediaId,
      sourceUri: videoFile.uri,
      size: imported.size,
      lotId,
      slot: 'video',
      index,
      createdAt: existingVideo?.createdAt || imported.createdAt,
    };
  }

  const ext = getFileExtension(videoFile.name || videoFile.uri, 'mp4');
  const persistedUri = await copyToDirectory(
    videoFile.uri,
    generateFilename(lotId, 'video', index, ext),
    destinationDir
  );

  if (!persistedUri) return null;

  return {
    uri: persistedUri,
    name: videoFile.name || `video-${index}.${ext}`,
    type: videoFile.type || 'video/mp4',
    sourceUri: videoFile.uri,
    size: await getFileSize(persistedUri),
    lotId,
    slot: 'video',
    index,
  };
};

const asSavedPhoto = (value?: SavedPhotoFileData | string): SavedPhotoFileData | string | null =>
  value || null;

const getExistingLot = (existingLots: SavedLotData[] | undefined, lotId: string, index: number) =>
  existingLots?.find((lot) => lot.id === lotId) || existingLots?.[index];

const persistLotsForStorage = async (
  lots: AutoSaveLotInput[],
  destinationDir: string,
  keepManagedEditedUri = true,
  existingLots?: SavedLotData[],
  draftId?: string
): Promise<SavedLotData[]> =>
  Promise.all(
    lots.map(async (lot, lotIndex) => {
      const existingLot = getExistingLot(existingLots, lot.id, lotIndex);
      const mainImages = (
        await Promise.all(
          lot.files.map((file, index) =>
            persistPhotoFile(
              file,
              lot.id,
              'main',
              index,
              destinationDir,
              keepManagedEditedUri,
              asSavedPhoto(existingLot?.mainImages?.[index]),
              draftId
            )
          )
        )
      ).filter(Boolean) as SavedPhotoFileData[];

      const extraImages = (
        await Promise.all(
          lot.extraFiles.map((file, index) =>
            persistPhotoFile(
              file,
              lot.id,
              'extra',
              index,
              destinationDir,
              keepManagedEditedUri,
              asSavedPhoto(existingLot?.extraImages?.[index]),
              draftId
            )
          )
        )
      ).filter(Boolean) as SavedPhotoFileData[];

      const videoCandidates = lot.videoFile
        ? [lot.videoFile]
        : Array.isArray(lot.videoFiles)
          ? lot.videoFiles
          : [];

      const videoFiles = (
        await Promise.all(
          videoCandidates.map((video, index) =>
            persistVideoFile(video, lot.id, index, destinationDir, existingLot?.videoFiles?.[index], draftId)
          )
        )
      ).filter(Boolean) as SavedVideoFileData[];

      return {
        id: lot.id,
        mode: lot.mode,
        mainImages,
        extraImages,
        videoFiles,
        coverIndex: lot.coverIndex,
      };
    })
  );

const getDraftKeepUris = (draft: Pick<OfflineReportDraft, 'lots'>): string[] => {
  const keep: string[] = [];
  for (const lot of draft.lots) {
    for (const image of [...lot.mainImages, ...lot.extraImages]) {
      if (typeof image === 'string') {
        keep.push(image);
      } else {
        keep.push(image.uri, image.originalUri || '', image.editedUri || '', image.displayUri || '', image.thumbnailUri || '');
      }
    }
    for (const video of lot.videoFiles || []) {
      keep.push(typeof video === 'string' ? video : video.uri);
    }
  }
  return keep.filter(Boolean);
};

const getDraftSourceUris = (draft: Pick<OfflineReportDraft, 'lots'>): string[] => {
  const uris: string[] = [];
  for (const lot of draft.lots) {
    for (const image of [...lot.mainImages, ...lot.extraImages]) {
      if (typeof image !== 'string') uris.push(image.sourceUri || '');
    }
    for (const video of lot.videoFiles || []) {
      if (typeof video !== 'string') uris.push(video.sourceUri || '');
    }
  }
  return uris.filter(Boolean);
};

const countDraftMedia = (draft: Pick<OfflineReportDraft, 'lots'>) =>
  draft.lots.reduce(
    (total, lot) =>
      total + lot.mainImages.length + lot.extraImages.length + (lot.videoFiles?.length || 0),
    0
  );

const countInputMedia = (lots: AutoSaveLotInput[]) =>
  lots.reduce(
    (total, lot) =>
      total + (lot.files?.length || 0) + (lot.extraFiles?.length || 0) + (lot.videoFile ? 1 : 0) + (lot.videoFiles?.length || 0),
    0
  );

const formatBytes = (bytes: number): string => {
  const gb = bytes / (1024 * 1024 * 1024);
  const mb = bytes / (1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return bytes > 0 ? '<1 MB' : '0 MB';
};

const getDeviceStorageStats = async (): Promise<{
  availableBytes?: number;
  totalBytes?: number;
}> => {
  const [available, total] = await Promise.all([
    FileSystem.getFreeDiskStorageAsync().catch(() => undefined),
    FileSystem.getTotalDiskCapacityAsync().catch(() => undefined),
  ]);

  return {
    availableBytes: typeof available === 'number' && Number.isFinite(available) ? available : undefined,
    totalBytes: typeof total === 'number' && Number.isFinite(total) ? total : undefined,
  };
};

const getLocalUrisSize = async (uris: Iterable<string | undefined | null>): Promise<number> => {
  const uniqueUris = new Set(
    Array.from(uris)
      .filter(Boolean)
      .map((uri) => String(uri))
      .filter((uri) => !/^https?:\/\//i.test(uri))
  );

  let total = 0;
  for (const uri of uniqueUris) {
    total += (await getFileSize(uri)) || 0;
  }
  return total;
};

const makeDraftId = (type: OfflineDraftType) =>
  `${type}-draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const normalizeDraftContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const getDraftNormalizedContractNo = (draft: Partial<OfflineReportDraft>) =>
  normalizeDraftContractNo(
    draft.normalizedContractNo || draft.contractNo || draft.formData?.contractNo
  );

const draftTitleFor = (type: OfflineDraftType, formData: AutoSaveFormData, fallback?: string) => {
  const trimmedFallback = fallback?.trim();
  if (trimmedFallback) return trimmedFallback;
  if (type === 'asset') {
    return formData.clientName?.trim() || formData.contractNo?.trim() || 'Asset Report';
  }
  return formData.contractNo?.trim() || formData.location?.trim() || 'Lot Listing';
};

const loadDraftsRaw = async (): Promise<OfflineReportDraft[]> => {
  const raw = await AsyncStorage.getItem(DRAFTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveDraftsRaw = async (drafts: OfflineReportDraft[]): Promise<void> => {
  await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
};

const deleteDraftDirectory = async (id: string): Promise<void> => {
  const draftDir = getDraftImagesDir(id);
  const legacyDraftDir = getLegacyDraftImagesDir(id);
  try {
    const info = await FileSystem.getInfoAsync(draftDir);
    if (info.exists) {
      await FileSystem.deleteAsync(draftDir, { idempotent: true });
    }
  } catch {
    // ignore cleanup failures
  }
  try {
    const legacyInfo = await FileSystem.getInfoAsync(legacyDraftDir);
    if (legacyInfo.exists) {
      await FileSystem.deleteAsync(legacyDraftDir, { idempotent: true });
    }
  } catch {
    // ignore cleanup failures
  }
};

const normalizeAutoSaveData = async (parsed: AutoSaveData): Promise<AutoSaveData> => {
  for (const [lotIndex, lot] of parsed.lots.entries()) {
    lot.mainImages = (
      await Promise.all(
        lot.mainImages.map((image, imageIndex) =>
          normalizeSavedPhotoFile(image, `restored-main-${lotIndex}-${imageIndex}.jpg`)
        )
      )
    ).filter(Boolean) as SavedLotData['mainImages'];

    lot.extraImages = (
      await Promise.all(
        lot.extraImages.map((image, imageIndex) =>
          normalizeSavedPhotoFile(image, `restored-extra-${lotIndex}-${imageIndex}.jpg`)
        )
      )
    ).filter(Boolean) as SavedLotData['extraImages'];

    lot.videoFiles = (
      await Promise.all(
        (lot.videoFiles || []).map((video, videoIndex) =>
          normalizeSavedVideoFile(video, `restored-video-${lotIndex}-${videoIndex}.mp4`)
        )
      )
    ).filter(Boolean) as SavedLotData['videoFiles'];
  }

  return parsed;
};

const normalizeDraftForRead = async (draft: OfflineReportDraft): Promise<OfflineReportDraft> => {
  const data: AutoSaveData = {
    formData: draft.formData,
    lots: draft.lots,
    activeLotIdx: draft.activeLotIdx,
    savedAt: draft.updatedAt,
    formType: draft.type,
  };

  const normalized = await normalizeAutoSaveData(data);

  return {
    ...draft,
    contractNo: draft.contractNo || normalized.formData.contractNo?.trim() || undefined,
    normalizedContractNo: getDraftNormalizedContractNo({
      ...draft,
      formData: normalized.formData,
    }) || undefined,
    formData: normalized.formData,
    lots: normalized.lots,
    activeLotIdx: normalized.activeLotIdx,
  };
};

const replaceOrAppendDraft = async (draft: OfflineReportDraft): Promise<OfflineReportDraft> => {
  const drafts = await loadDraftsRaw();
  const normalizedContractNo = getDraftNormalizedContractNo(draft);
  const existingIndex = drafts.findIndex(
    (item) =>
      item.id === draft.id ||
      (item.type === draft.type && getDraftNormalizedContractNo(item) === normalizedContractNo)
  );

  const nextDrafts = [...drafts];
  if (existingIndex >= 0) {
    nextDrafts[existingIndex] = {
      ...draft,
      id: nextDrafts[existingIndex].id || draft.id,
      createdAt: nextDrafts[existingIndex].createdAt || draft.createdAt,
    };
  } else {
    nextDrafts.push(draft);
  }

  await saveDraftsRaw(nextDrafts);
  return normalizeDraftForRead(existingIndex >= 0 ? nextDrafts[existingIndex] : draft);
};

export const AutoSaveService = {
  async migrateLegacyAutoSaveIfNeeded(): Promise<void> {
    try {
      const alreadyMigrated = await AsyncStorage.getItem(LEGACY_MIGRATED_KEY);
      if (alreadyMigrated) return;

      const raw = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      if (!raw) {
        await AsyncStorage.setItem(LEGACY_MIGRATED_KEY, '1');
        return;
      }

      const parsed: AutoSaveData = JSON.parse(raw);
      if (parsed.formType !== 'asset' && parsed.formType !== 'lotListing') {
        await AsyncStorage.setItem(LEGACY_MIGRATED_KEY, '1');
        return;
      }

      const existing = await loadDraftsRaw();
      const now = parsed.savedAt || new Date().toISOString();
      const id = makeDraftId(parsed.formType);
      const contractNo = parsed.formData.contractNo?.trim() || undefined;
      existing.push({
        id,
        type: parsed.formType,
        title: draftTitleFor(parsed.formType, parsed.formData),
        contractNo,
        normalizedContractNo: normalizeDraftContractNo(contractNo) || undefined,
        formData: parsed.formData,
        lots: parsed.lots,
        activeLotIdx: parsed.activeLotIdx,
        createdAt: now,
        updatedAt: now,
      });
      await saveDraftsRaw(existing);
      await AsyncStorage.setItem(LEGACY_MIGRATED_KEY, '1');
    } catch (error) {
      console.error('Error migrating legacy auto-save:', error);
    }
  },

  async getDrafts(type?: OfflineDraftType): Promise<OfflineReportDraft[]> {
    await this.migrateLegacyAutoSaveIfNeeded();
    const drafts = await loadDraftsRaw();
    const filtered = type ? drafts.filter((draft) => draft.type === type) : drafts;
    const normalized = await Promise.all(filtered.map((draft) => normalizeDraftForRead(draft)));
    return normalized.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  },

  async getDraft(id: string): Promise<OfflineReportDraft | null> {
    await this.migrateLegacyAutoSaveIfNeeded();
    const drafts = await loadDraftsRaw();
    const draft = drafts.find((item) => item.id === id);
    return draft ? normalizeDraftForRead(draft) : null;
  },

  async saveDraft(args: {
    id?: string | null;
    type: OfflineDraftType;
    title?: string;
    formData: AutoSaveFormData;
    lots: AutoSaveLotInput[];
    activeLotIdx: number;
  }): Promise<OfflineReportDraft> {
    await this.migrateLegacyAutoSaveIfNeeded();

    const drafts = await loadDraftsRaw();
    const contractNo = args.formData.contractNo?.trim();
    const normalizedContractNo = normalizeDraftContractNo(contractNo);
    if (!normalizedContractNo) {
      throw new Error('Contract number is required before saving this draft.');
    }

    const idIndex = args.id ? drafts.findIndex((draft) => draft.id === args.id) : -1;
    const contractIndex = drafts.findIndex(
      (draft) => draft.type === args.type && getDraftNormalizedContractNo(draft) === normalizedContractNo
    );
    const existingIndex = contractIndex >= 0 ? contractIndex : idIndex;
    const existing = existingIndex >= 0 ? drafts[existingIndex] : null;
    const duplicateIdToRemove =
      idIndex >= 0 && contractIndex >= 0 && idIndex !== contractIndex ? drafts[idIndex].id : null;
    const id = existing?.id || args.id || makeDraftId(args.type);
    const now = new Date().toISOString();
    const lots = await persistLotsForStorage(
      args.lots,
      getDraftImagesDir(id),
      false,
      existing?.lots,
      id
    );
    const expectedMedia = countInputMedia(args.lots);
    const persistedMedia = countDraftMedia({ lots } as OfflineReportDraft);
    if (expectedMedia > 0 && persistedMedia < expectedMedia) {
      throw new Error(
        `Draft media save failed: saved ${persistedMedia} of ${expectedMedia} captured file(s). Keep the form open and try saving again.`
      );
    }

    const draft: OfflineReportDraft = {
      id,
      type: args.type,
      title: draftTitleFor(args.type, args.formData, args.title),
      contractNo,
      normalizedContractNo,
      cloudId: existing?.cloudId,
      cloudSyncedAt: existing?.cloudSyncedAt,
      formData: args.formData,
      lots,
      activeLotIdx: args.activeLotIdx,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    let nextDrafts = drafts;
    if (existingIndex >= 0) {
      nextDrafts = [...drafts];
      nextDrafts[existingIndex] = draft;
    } else {
      nextDrafts = [...drafts, draft];
    }

    if (duplicateIdToRemove) {
      nextDrafts = nextDrafts.filter((item) => item.id !== duplicateIdToRemove);
    }

    await saveDraftsRaw(nextDrafts);
    await LocalMediaStore.pruneDraftFiles(id, getDraftKeepUris(draft));
    if (duplicateIdToRemove) {
      await deleteDraftDirectory(duplicateIdToRemove);
    }
    return draft;
  },

  async markDraftCloudSynced(id: string, cloudId: string): Promise<void> {
    const drafts = await loadDraftsRaw();
    const now = new Date().toISOString();
    await saveDraftsRaw(
      drafts.map((draft) =>
        draft.id === id
          ? {
              ...draft,
              cloudId,
              cloudSyncedAt: now,
              cloudSyncError: undefined,
            }
          : draft
      )
    );
  },

  async markDraftCloudSyncError(id: string, message: string): Promise<void> {
    const drafts = await loadDraftsRaw();
    await saveDraftsRaw(
      drafts.map((draft) =>
        draft.id === id
          ? {
              ...draft,
              cloudSyncError: message,
            }
          : draft
      )
    );
  },

  async saveCloudDraftSnapshot(args: {
    id?: string;
    cloudId?: string;
    type: OfflineDraftType;
    title?: string;
    contractNo?: string;
    normalizedContractNo?: string;
    formData: AutoSaveFormData;
    lots: SavedLotData[];
    activeLotIdx: number;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<OfflineReportDraft> {
    const now = new Date().toISOString();
    const contractNo = args.contractNo || args.formData.contractNo?.trim();
    const normalizedContractNo = args.normalizedContractNo || normalizeDraftContractNo(contractNo);
    if (!normalizedContractNo) {
      throw new Error('Contract number is required before saving this draft.');
    }

    return replaceOrAppendDraft({
      id: args.id || makeDraftId(args.type),
      type: args.type,
      title: draftTitleFor(args.type, args.formData, args.title),
      contractNo,
      normalizedContractNo,
      cloudId: args.cloudId,
      cloudSyncedAt: now,
      formData: args.formData,
      lots: args.lots,
      activeLotIdx: args.activeLotIdx,
      createdAt: args.createdAt || now,
      updatedAt: args.updatedAt || now,
    });
  },

  async deleteDraft(id: string): Promise<void> {
    const drafts = await loadDraftsRaw();
    const draft = drafts.find((item) => item.id === id);

    if (draft) {
      for (const lot of draft.lots) {
        for (const image of [...lot.mainImages, ...lot.extraImages]) {
          if (typeof image === 'string') {
            await deleteLocalFile(image);
          } else {
            await deleteLocalFile(image.uri);
            await deleteLocalFile(image.originalUri);
            await deleteLocalFile(image.editedUri);
          }
        }

        for (const video of lot.videoFiles || []) {
          await deleteLocalFile(typeof video === 'string' ? video : video.uri);
        }
      }
    }

    await deleteDraftDirectory(id);

    await saveDraftsRaw(drafts.filter((item) => item.id !== id));
  },

  async removeDraftRecordOnly(id: string): Promise<void> {
    const drafts = await loadDraftsRaw();
    await saveDraftsRaw(drafts.filter((item) => item.id !== id));
  },

  async deleteDraftMedia(id: string): Promise<void> {
    await deleteDraftDirectory(id);
  },

  async getLocalStorageSummary(
    extraFileUris: string[] = [],
    extraCounts: { images?: number; videos?: number } = {}
  ): Promise<{
    bytes: number;
    formatted: string;
    drafts: number;
    images: number;
    videos: number;
    availableBytes?: number;
    availableFormatted?: string;
    totalBytes?: number;
    totalFormatted?: string;
  }> {
    const drafts = await this.getDrafts();
    const counts = drafts.reduce(
      (acc, draft) => {
        for (const lot of draft.lots) {
          acc.images += lot.mainImages.length + lot.extraImages.length;
          acc.videos += lot.videoFiles?.length || 0;
        }
        return acc;
      },
      { images: 0, videos: 0 }
    );
    const bytes = await getLocalUrisSize([
      ...drafts.flatMap((draft) => getDraftKeepUris(draft)),
      ...extraFileUris,
    ]);
    const device = await getDeviceStorageStats();

    return {
      bytes,
      formatted: formatBytes(bytes),
      drafts: drafts.length,
      images: counts.images + (extraCounts.images || 0),
      videos: counts.videos + (extraCounts.videos || 0),
      availableBytes: device.availableBytes,
      availableFormatted:
        device.availableBytes !== undefined ? formatBytes(device.availableBytes) : undefined,
      totalBytes: device.totalBytes,
      totalFormatted: device.totalBytes !== undefined ? formatBytes(device.totalBytes) : undefined,
    };
  },

  async cleanupOrphanedMedia(activeFileUris: string[] = [], maxNativeCacheAgeMs?: number): Promise<number> {
    const drafts = await loadDraftsRaw();
    const activeUris = [
      ...activeFileUris,
      ...drafts.flatMap((draft) => getDraftKeepUris(draft)),
      ...drafts.flatMap((draft) => getDraftSourceUris(draft)),
    ];
    const deletedDraftBytes = await LocalMediaStore.cleanupOrphanedDraftFolders(
      drafts.map((draft) => draft.id),
      activeUris
    );
    const deletedNativeBytes = await LocalMediaStore.cleanupNativeCameraCache(
      activeUris,
      maxNativeCacheAgeMs
    );
    return deletedDraftBytes + deletedNativeBytes;
  },

  async getDraftSummary(): Promise<{ total: number; asset: number; lotListing: number }> {
    const drafts = await this.getDrafts();
    return {
      total: drafts.length,
      asset: drafts.filter((draft) => draft.type === 'asset').length,
      lotListing: drafts.filter((draft) => draft.type === 'lotListing').length,
    };
  },

  async hasAutoSave(): Promise<boolean> {
    try {
      const data = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      return data !== null;
    } catch (error) {
      console.error('Error checking auto-save:', error);
      return false;
    }
  },

  async getAutoSave(): Promise<AutoSaveData | null> {
    try {
      const data = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      if (!data) return null;

      const parsed: AutoSaveData = JSON.parse(data);
      return normalizeAutoSaveData(parsed);
    } catch (error) {
      console.error('Error getting auto-save:', error);
      return null;
    }
  },

  async saveAutoSave(
    formData: AutoSaveFormData,
    lots: AutoSaveLotInput[],
    activeLotIdx: number,
    formType: 'asset' | 'realEstate' | 'lotListing' = 'asset'
  ): Promise<void> {
    try {
      await ensureDirectoryExists();

      const savedLots = await persistLotsForStorage(lots, getAutoSaveImagesDir(), true);

      const autoSaveData: AutoSaveData = {
        formData,
        lots: savedLots,
        activeLotIdx,
        savedAt: new Date().toISOString(),
        formType,
      };

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(autoSaveData));
    } catch (error) {
      console.error('Error saving auto-save:', error);
      throw error;
    }
  },

  async saveImage(
    lotId: string,
    imageUri: string,
    type: 'main' | 'extra' | 'video',
    index: number
  ): Promise<string> {
    try {
      const ext = type === 'video' ? 'mp4' : 'jpg';
      return await copyToAutoSaveDir(imageUri, generateFilename(lotId, type, index, ext));
    } catch (error) {
      console.error('Error saving image:', error);
      return '';
    }
  },

  async deleteAutoSave(): Promise<void> {
    try {
      const existing = await this.getAutoSave();
      if (existing) {
        for (const lot of existing.lots) {
          for (const image of lot.mainImages) {
            if (typeof image === 'string') {
              await deleteLocalFile(image);
            } else {
              await deleteLocalFile(image.uri);
              await deleteLocalFile(image.originalUri);
              await deleteLocalFile(image.editedUri);
            }
          }

          for (const image of lot.extraImages) {
            if (typeof image === 'string') {
              await deleteLocalFile(image);
            } else {
              await deleteLocalFile(image.uri);
              await deleteLocalFile(image.originalUri);
              await deleteLocalFile(image.editedUri);
            }
          }

          for (const video of lot.videoFiles || []) {
            await deleteLocalFile(typeof video === 'string' ? video : video.uri);
          }
        }
      }

      const dirInfo = await FileSystem.getInfoAsync(getAutoSaveImagesDir());
      if (dirInfo.exists) {
        await FileSystem.deleteAsync(getAutoSaveImagesDir(), { idempotent: true });
      }

      await AsyncStorage.removeItem(AUTO_SAVE_KEY);
    } catch (error) {
      console.error('Error deleting auto-save:', error);
      throw error;
    }
  },

  async getAutoSaveSummary(): Promise<{
    exists: boolean;
    savedAt?: string;
    totalImages?: number;
    totalLots?: number;
    formType?: string;
  }> {
    try {
      const data = await this.getAutoSave();
      if (!data) {
        return { exists: false };
      }

      const totalImages = data.lots.reduce(
        (sum, lot) => sum + lot.mainImages.length + lot.extraImages.length,
        0
      );

      return {
        exists: true,
        savedAt: data.savedAt,
        totalImages,
        totalLots: data.lots.length,
        formType: data.formType,
      };
    } catch (error) {
      console.error('Error getting auto-save summary:', error);
      return { exists: false };
    }
  },

  async updateFormData(formData: AutoSaveFormData): Promise<void> {
    try {
      const existing = await this.getAutoSave();
      if (!existing) return;

      existing.formData = { ...existing.formData, ...formData };
      existing.savedAt = new Date().toISOString();

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(existing));
    } catch (error) {
      console.error('Error updating form data:', error);
    }
  },

  async updateLots(lots: SavedLotData[], activeLotIdx: number): Promise<void> {
    try {
      const existing = await this.getAutoSave();
      if (!existing) return;

      existing.lots = lots;
      existing.activeLotIdx = activeLotIdx;
      existing.savedAt = new Date().toISOString();

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(existing));
    } catch (error) {
      console.error('Error updating lots:', error);
    }
  },
};

export default AutoSaveService;
