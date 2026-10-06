import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import AutoSaveService, {
  AutoSaveFormData,
  OfflineDraftType,
  OfflineReportDraft,
  SavedLotData,
  SavedPhotoFileData,
  SavedVideoFileData,
} from '../services/autoSaveService';
import OfflineQueueService, { OfflineQueueJob } from '../services/offlineQueueService';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import OfflineCaptureList from '../components/OfflineCaptureList';
import { useBackgroundUploads } from '../components/useBackgroundUploads';
import backgroundUploadManager, { describeBackgroundUpload } from '../services/backgroundUploadManager';
import reportDraftService, { ReportDraft } from '../services/reportDraftService';
import DraftSyncService from '../services/draftSyncService';
import {
  canAttemptDraftCloudSync,
  getDraftCloudSyncMessage,
  isRecoverableDraftCloudError,
} from '../services/draftCloudSyncState';
import api from '../services/api';
import type { ConnectivityStatus } from '../services/connectivityService';

type LegacyFormType = 'asset' | 'realEstate';

interface SavedInput {
  _id: string;
  name: string;
  formType: LegacyFormType;
  formData: Record<string, any>;
  isDraft?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OfflineReportsScreenProps {
  onOpenDrawer: () => void;
  onBack?: () => void;
  onContinueDraft: (draftId: string, type: OfflineDraftType) => void;
  onLoadSavedInput?: (savedInput: SavedInput) => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  initialTab?: 'saved' | 'drafts' | 'queue';
}

type UnifiedDraftItem =
  | {
      id: string;
      source: 'local';
      type: OfflineDraftType;
      title: string;
      contractNo: string;
      updatedAt: string;
      status: 'Local' | 'Syncing' | 'Waiting to upload' | 'Cloud saved' | 'Failed';
      counts: { lots: number; images: number; videos: number };
      draft: OfflineReportDraft;
      cloud?: ReportDraft;
    }
  | {
      id: string;
      source: 'cloud';
      type: OfflineDraftType;
      title: string;
      contractNo: string;
      updatedAt: string;
      status: 'Cloud saved';
      counts: { lots: number; images: number; videos: number };
      cloud: ReportDraft;
    }
  | {
      id: string;
      source: 'queue';
      type: OfflineDraftType;
      title: string;
      contractNo: string;
      updatedAt: string;
      status: 'Waiting to upload' | 'Uploading' | 'Failed';
      counts: { lots: number; images: number; videos: number };
      job: OfflineQueueJob;
    }
  | {
      id: string;
      source: 'legacySavedInput';
      type: LegacyFormType;
      title: string;
      contractNo: string;
      updatedAt: string;
      status: 'Cloud saved';
      counts: { lots: number; images: number; videos: number };
      savedInput: SavedInput;
    };

const typeConfig = {
  asset: {
    label: 'Asset Report',
    icon: 'package',
    color: '#E11D48',
    soft: '#FFE4E6',
  },
  lotListing: {
    label: 'Lot Listing',
    icon: 'list',
    color: '#7C3AED',
    soft: '#F3E8FF',
  },
  realEstate: {
    label: 'Real Estate',
    icon: 'home',
    color: '#059669',
    soft: '#D1FAE5',
  },
} as const;

const formatDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const normalizeContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const draftKey = (type: string, value?: string | null) => `${type}:${normalizeContractNo(value)}`;


const getDraftCounts = (draft: Pick<OfflineReportDraft | ReportDraft, 'lots'> & { media?: any[] }) => {
  let images = 0;
  let videos = 0;
  const lots = Array.isArray(draft.lots) ? draft.lots : [];
  lots.forEach((lot: any) => {
    images += (lot.mainImages?.length || 0) + (lot.extraImages?.length || 0);
    videos += lot.videoFiles?.length || 0;
  });
  if (images === 0 && videos === 0 && Array.isArray(draft.media)) {
    draft.media.forEach((item: any) => {
      const slot = String(item?.slot || '').toLowerCase();
      const mimeType = String(item?.mimeType || item?.type || '').toLowerCase();
      if (slot === 'video' || mimeType.startsWith('video/')) {
        videos += 1;
      } else if (slot === 'main' || slot === 'extra' || mimeType.startsWith('image/')) {
        images += 1;
      }
    });
  }
  return { lots: lots.length, images, videos };
};

const getJobCounts = (job: OfflineQueueJob) => {
  let images = 0;
  let videos = 0;
  const lots = Array.isArray(job.lots) ? job.lots : [];
  lots.forEach((lot) => {
    images += (lot.files?.length || 0) + (lot.extraFiles?.length || 0);
    if (lot.videoFile?.uri) videos += 1;
  });
  return { lots: lots.length, images, videos };
};

const getJobTitle = (job: OfflineQueueJob) => {
  if (job.type === 'asset') {
    return (
      job.details?.client_name ||
      job.details?.contract_no ||
      job.details?.owner_name ||
      'Asset Report'
    );
  }
  return job.details?.contract_no || job.details?.location || 'Lot Listing';
};

const getJobContractNo = (job: OfflineQueueJob) =>
  job.type === 'asset' ? job.details?.contract_no || '-' : job.details?.contract_no || '-';

const isRecoverableQueueError = (job: OfflineQueueJob) =>
  job.lastErrorKind === 'network' ||
  job.lastErrorKind === 'transient_server' ||
  /upload paused|connection was interrupted|network error|network request failed|failed to fetch|timeout/i.test(
    String(job.lastError || '')
  );

const isDraftCloudClean = (draft: OfflineReportDraft, cloud?: ReportDraft) => {
  if (!cloud && !draft.cloudSyncedAt) return false;
  const syncedAt = draft.cloudSyncedAt || cloud?.updatedAt;
  if (!syncedAt) return false;
  return new Date(syncedAt).getTime() >= new Date(draft.updatedAt).getTime();
};

// A draft the background upload line holds -- sending, waiting in line, paused
// or needing attention -- is not cloud-synced by this screen (2026-10-02). That
// sync ends by replacing the local draft with its cloud copy and deleting its
// local photos, which the background upload reads and a Resume from the upload
// bar sends again. syncOneDraft checks again after the cloud save, because
// Submit can hand the draft over while that save is still running.
const heldByBackgroundUpload = (draftId: string) => Boolean(backgroundUploadManager.statusFor(draftId));


const hydrateCloudLots = (cloud: ReportDraft): SavedLotData[] => {
  const lots = (JSON.parse(JSON.stringify(cloud.lots || [])) as SavedLotData[]).map(
    (lot, index): SavedLotData => ({
      ...lot,
      id: String(lot.id || `draft-lot-${index + 1}`),
      mainImages: [] as SavedPhotoFileData[],
      extraImages: [] as SavedPhotoFileData[],
      videoFiles: [] as SavedVideoFileData[],
    })
  );
  const lotById = new Map(lots.map((lot) => [String(lot.id), lot]));
  const lotRank = new Map(lots.map((lot, index) => [String(lot.id), index]));
  const slotRank = { main: 0, extra: 1, video: 2 } as const;
  const media = [...(cloud.media || [])].sort((a, b) => {
    const lot =
      (lotRank.get(String(a.lotId || '')) ?? Number.MAX_SAFE_INTEGER) -
      (lotRank.get(String(b.lotId || '')) ?? Number.MAX_SAFE_INTEGER);
    const slot =
      (slotRank[a.slot as keyof typeof slotRank] ?? 9) -
      (slotRank[b.slot as keyof typeof slotRank] ?? 9);
    const orderA = Number.isFinite(Number(a.originalOrder))
      ? Number(a.originalOrder)
      : Number(a.captureOrder ?? a.index ?? 0);
    const orderB = Number.isFinite(Number(b.originalOrder))
      ? Number(b.originalOrder)
      : Number(b.captureOrder ?? b.index ?? 0);
    return lot || slot || orderA - orderB || Number(a.index || 0) - Number(b.index || 0);
  });

  for (const item of media) {
    if (!item.url || !item.lotId || !item.slot) continue;
    const lot = lotById.get(String(item.lotId));
    if (!lot) continue;

    const photo: SavedPhotoFileData = {
      uri: item.url,
      originalUri: item.url,
      displayUri: item.url,
      name: item.name || `${item.slot}-${item.index}.jpg`,
      type: item.mimeType || (item.slot === 'video' ? 'video/mp4' : 'image/jpeg'),
      clientFileId: item.clientFileId,
      localKey: item.localKey,
      mediaId: item.mediaId || item.clientFileId,
      lotId: item.lotId,
      slot: item.slot === 'extra' ? 'extra' : 'main',
      index: item.index,
      captureOrder: item.captureOrder,
      originalOrder: item.originalOrder,
      size: item.verifiedSize || item.size,
    };

    if (item.slot === 'main') {
      lot.mainImages.push(photo);
    } else if (item.slot === 'extra') {
      lot.extraImages.push(photo);
    } else if (item.slot === 'video') {
      lot.videoFiles.push({
        uri: item.url,
        name: item.name || `video-${item.index}.mp4`,
        type: item.mimeType || 'video/mp4',
        clientFileId: item.clientFileId,
        localKey: item.localKey,
        mediaId: item.mediaId || item.clientFileId,
        lotId: item.lotId,
        slot: 'video',
        index: item.index,
        captureOrder: item.captureOrder,
        originalOrder: item.originalOrder,
        size: item.verifiedSize || item.size,
      });
    }
  }

  return lots;
};

const OfflineReportsScreen = ({
  onOpenDrawer,
  onContinueDraft,
  onLoadSavedInput,
  unreadCount = 0,
  onOpenNotifications,
}: OfflineReportsScreenProps) => {
  const [savedInputs, setSavedInputs] = useState<SavedInput[]>([]);
  const [drafts, setDrafts] = useState<OfflineReportDraft[]>([]);
  const [cloudDrafts, setCloudDrafts] = useState<ReportDraft[]>([]);
  const [jobs, setJobs] = useState<OfflineQueueJob[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectivityStatus>('unknown');
  const online = connectionStatus === 'online';
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingDraftIds, setSyncingDraftIds] = useState<Set<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  // Re-renders with every background upload change, so each card shows its
  // live status (services/backgroundUploadManager.ts).
  useBackgroundUploads();
  const [storageSummary, setStorageSummary] = useState<{
    bytes: number;
    formatted: string;
    drafts: number;
    images: number;
    videos: number;
    availableBytes?: number;
    availableFormatted?: string;
    totalBytes?: number;
    totalFormatted?: string;
  } | null>(null);

  const syncOneDraft = useCallback(async (draft: OfflineReportDraft, force = false) => {
    if (!canAttemptDraftCloudSync(draft, { force }) || heldByBackgroundUpload(draft.id)) return;
    setSyncingDraftIds((prev) => new Set(prev).add(draft.id));
    try {
      const result = await DraftSyncService.syncDraft(draft, { force });
      if (result.status === 'skipped') return;
      if (result.status === 'failed') {
        const latest = await AutoSaveService.getDraft(draft.id);
        if (latest) {
          setDrafts((prev) => prev.map((item) => (item.id === latest.id ? latest : item)));
        }
        return;
      }

      const cloud = result.cloud;
      const current = await AutoSaveService.getDraft(draft.id);
      if (current && current.updatedAt !== draft.updatedAt) {
        // The form changed while this revision was uploading. Keep the newer
        // local revision and let the next sync send it instead of overwriting it.
        setDrafts((prev) => prev.map((item) => (item.id === current.id ? current : item)));
        return;
      }
      if (heldByBackgroundUpload(draft.id)) return;

      const saved = await AutoSaveService.saveCloudDraftSnapshot({
        id: draft.id,
        cloudId: cloud.id || cloud._id || '',
        type: cloud.type,
        title: cloud.title,
        contractNo: cloud.contractNo,
        normalizedContractNo: cloud.normalizedContractNo,
        formData: cloud.formData,
        lots: hydrateCloudLots(cloud),
        activeLotIdx: cloud.activeLotIdx || 0,
        createdAt: cloud.createdAt,
        updatedAt: cloud.updatedAt,
      });
      // R2 is now the durable source. Remove the local byte cache only after
      // every manifest row has been verified by the server.
      await AutoSaveService.deleteDraftMedia(draft.id);
      setDrafts((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
      setCloudDrafts((prev) => {
        const key = draftKey(cloud.type, cloud.clientDraftId || cloud.id || cloud._id);
        const others = prev.filter((item) => draftKey(item.type, item.clientDraftId || item.id || item._id) !== key);
        return [cloud, ...others].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
    } catch {
      // DraftSyncService persists classified failures. This guard protects the
      // screen from a local snapshot/update failure without exposing raw Axios text.
      const latest = await AutoSaveService.getDraft(draft.id);
      if (latest) {
        setDrafts((prev) => prev.map((item) => (item.id === latest.id ? latest : item)));
      }
    } finally {
      setSyncingDraftIds((prev) => {
        const next = new Set(prev);
        next.delete(draft.id);
        return next;
      });
    }
  }, []);

  const loadData = useCallback(async (syncAfterLoad = true) => {
    const [nextDrafts, nextJobs, connectivity] = await Promise.all([
      OfflineCaptureStore.listSummaries().then(async (summaries) => {
        const online = summaries.filter((draft) => draft.captureMode !== 'offline' && !draft.manualSubmissionRequired);
        const drafts: OfflineReportDraft[] = [];
        for (const summary of online) { const draft = await AutoSaveService.getDraft(summary.id); if (draft) drafts.push(draft); }
        return drafts;
      }),
      OfflineQueueService.getJobs(),
      OfflineQueueService.getConnectivityStatus(),
    ]);

    let nextSavedInputs: SavedInput[] = [];
    if (connectivity.status === 'online') {
      try {
        const { data } = await api.get('/saved-inputs');
        nextSavedInputs = (data.data || []).filter((item: SavedInput) => !item.isDraft);
      } catch {
        nextSavedInputs = [];
      }
    }

    let nextCloudDrafts: ReportDraft[] = [];
    if (connectivity.status === 'online') {
      try {
        nextCloudDrafts = await reportDraftService.list();
      } catch {
        nextCloudDrafts = [];
      }
    }

    setDrafts(nextDrafts);
    setJobs(nextJobs);
    setSavedInputs(nextSavedInputs);
    setCloudDrafts(nextCloudDrafts);
    setConnectionStatus(connectivity.status);
    const queueCounts = nextJobs.reduce(
      (sum, job) => {
        const counts = getJobCounts(job);
        return {
          images: sum.images + counts.images,
          videos: sum.videos + counts.videos,
        };
      },
      { images: 0, videos: 0 }
    );

    void AutoSaveService.getLocalStorageSummary(
      nextJobs.flatMap((job) => job.fileUris || []),
      queueCounts
    )
      .then(setStorageSummary)
      .catch(() => undefined);

    if (connectivity.status === 'online' && syncAfterLoad) {
      const cloudByKey = new Map(
        nextCloudDrafts.map((draft) => [
          draftKey(draft.type, draft.clientDraftId || draft.id || draft._id),
          draft,
        ])
      );
      for (const draft of nextDrafts) {
        const cloud = cloudByKey.get(draftKey(draft.type, draft.id));
        if (!isDraftCloudClean(draft, cloud)) {
          void syncOneDraft(draft);
        }
      }
    }
  }, [syncOneDraft]);

  useEffect(() => {
    let mounted = true;
    const start = async () => {
      try {
        await loadData();
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void start();
    const unsubscribe = OfflineQueueService.subscribe((nextJobs) => {
      setJobs(
        [...nextJobs].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );
    });
    const timer = setInterval(() => {
      void loadData();
    }, 15000);

    return () => {
      mounted = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [loadData]);

  // A draft accepted in the background leaves the list at once.
  useEffect(() => backgroundUploadManager.onAccepted(() => { void loadData(false); }), [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [loadData]);

  const cloudByKey = useMemo(() => {
    const map = new Map<string, ReportDraft>();
    for (const draft of cloudDrafts) {
      map.set(draftKey(draft.type, draft.clientDraftId || draft.id || draft._id), draft);
    }
    return map;
  }, [cloudDrafts]);

  const items = useMemo<UnifiedDraftItem[]>(() => {
    const localKeys = new Set<string>();
    const merged: UnifiedDraftItem[] = [];

    for (const draft of drafts) {
      const key = draftKey(draft.type, draft.id);
      localKeys.add(key);
      const cloud = cloudByKey.get(key);
      const status: UnifiedDraftItem['status'] = syncingDraftIds.has(draft.id)
        ? 'Syncing'
        : draft.cloudSyncError
          ? isRecoverableDraftCloudError(draft)
            ? 'Waiting to upload'
            : 'Failed'
          : isDraftCloudClean(draft, cloud)
            ? 'Cloud saved'
            : 'Local';

      merged.push({
        id: `local:${draft.id}`,
        source: 'local',
        type: draft.type,
        title: draft.title,
        contractNo: draft.contractNo || draft.formData.contractNo || '-',
        updatedAt: draft.updatedAt,
        status,
        counts: getDraftCounts(draft),
        draft,
        cloud,
      });
    }

    for (const cloud of cloudDrafts) {
      const key = draftKey(cloud.type, cloud.clientDraftId || cloud.id || cloud._id);
      if (localKeys.has(key)) continue;
      merged.push({
        id: `cloud:${cloud.id || cloud._id}`,
        source: 'cloud',
        type: cloud.type,
        title: cloud.title || cloud.contractNo,
        contractNo: cloud.contractNo,
        updatedAt: cloud.updatedAt,
        status: 'Cloud saved',
        counts: getDraftCounts(cloud),
        cloud,
      });
    }

    for (const job of jobs) {
      const recoverableQueueError = isRecoverableQueueError(job);
      merged.push({
        id: `queue:${job.id}`,
        source: 'queue',
        type: job.type,
        title: getJobTitle(job),
        contractNo: getJobContractNo(job),
        updatedAt: job.createdAt,
        status: sendingIds.has(job.id)
          ? 'Uploading'
          : job.lastError && !recoverableQueueError
            ? 'Failed'
            : 'Waiting to upload',
        counts: getJobCounts(job),
        job,
      });
    }

    for (const savedInput of savedInputs) {
      merged.push({
        id: `legacy:${savedInput._id}`,
        source: 'legacySavedInput',
        type: savedInput.formType,
        title: savedInput.name,
        contractNo: savedInput.formData?.contractNo || savedInput.formData?.property_details?.address || '-',
        updatedAt: savedInput.updatedAt || savedInput.createdAt,
        status: 'Cloud saved',
        counts: { lots: 0, images: 0, videos: 0 },
        savedInput,
      });
    }

    return merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [cloudByKey, cloudDrafts, drafts, jobs, savedInputs, sendingIds, syncingDraftIds]);

  const totals = useMemo(() => {
    const media = drafts.reduce(
      (sum, draft) => {
        const counts = getDraftCounts(draft);
        return {
          images: sum.images + counts.images,
          videos: sum.videos + counts.videos,
        };
      },
      { images: 0, videos: 0 }
    );

    return {
      total: items.length,
      local: items.filter(
        (item) => item.status === 'Local' || item.status === 'Waiting to upload'
      ).length,
      queued: jobs.length,
      images: media.images,
      videos: media.videos,
    };
  }, [drafts, items, jobs.length]);

  const unsyncedDrafts = useMemo(
    () => drafts.filter((draft) => !isDraftCloudClean(draft, cloudByKey.get(draftKey(draft.type, draft.normalizedContractNo || draft.contractNo)))),
    [cloudByKey, drafts]
  );

  const syncAll = useCallback(async () => {
    if (!online || syncing || unsyncedDrafts.length === 0) return;
    setSyncing(true);
    try {
      for (const draft of unsyncedDrafts) {
        await syncOneDraft(draft, true);
      }
      await loadData(false);
    } finally {
      setSyncing(false);
    }
  }, [loadData, online, syncOneDraft, syncing, unsyncedDrafts]);

  const sendQueued = useCallback(async (job: OfflineQueueJob) => {
    if (!online) {
      Alert.alert(
        connectionStatus === 'offline' ? 'No Internet Connection' : 'Server Unavailable',
        connectionStatus === 'offline'
          ? 'Upload paused on this device. Connect and tap Resume upload; it will not submit automatically.'
          : 'Internet may be available, but the server cannot be reached right now. The report remains safely queued.'
      );
      return;
    }
    setSendingIds((prev) => new Set(prev).add(job.id));
    try {
      const result = await OfflineQueueService.retryJob(job.id);
      await loadData(false);
      Alert.alert(
        result.status === 'submitted'
          ? 'Upload Sent'
          : result.status === 'waiting'
            ? 'Upload Waiting'
            : 'Upload Needs Attention',
        result.message
      );
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  }, [connectionStatus, loadData, online]);

  const sendAll = useCallback(async () => {
    if (!online || jobs.length === 0 || syncing) return;
    setSyncing(true);
    try {
      await OfflineQueueService.retryAll();
      await loadData(false);
    } finally {
      setSyncing(false);
    }
  }, [jobs.length, loadData, online, syncing]);

  const cleanCompletedStorage = useCallback(async () => {
    try {
      const activeUris = jobs.flatMap((job) => job.fileUris || []);
      const deletedBytes = await AutoSaveService.cleanupOrphanedMedia(activeUris);
      const queueCounts = jobs.reduce(
        (sum, job) => {
          const counts = getJobCounts(job);
          return {
            images: sum.images + counts.images,
            videos: sum.videos + counts.videos,
          };
        },
        { images: 0, videos: 0 }
      );
      const nextSummary = await AutoSaveService.getLocalStorageSummary(activeUris, queueCounts);
      setStorageSummary(nextSummary);
      const mb = deletedBytes / (1024 * 1024);
      Alert.alert(
        'Storage cleaned',
        deletedBytes > 0
          ? `Freed about ${mb >= 1 ? mb.toFixed(0) : '<1'} MB of completed or orphaned report media.`
          : 'No completed or orphaned report media was safe to remove.'
      );
    } catch (error: any) {
      Alert.alert('Cleanup failed', error?.message || 'Unable to clean local report media.');
    }
  }, [jobs]);

  const submitLocalDraft = useCallback((draft: OfflineReportDraft) => {
    // Every draft uses the canonical form's complete settings, validation, and
    // same-ID upload flow. Opening this screen never submits or clears a draft.
    onContinueDraft(draft.id, draft.type);
  }, [onContinueDraft]);

  const continueCloudDraft = useCallback(async (cloud: ReportDraft) => {
    // Restoring from the cloud replaces the local draft and deletes its local
    // media, so never while that draft is uploading in the background.
    if (cloud.clientDraftId && backgroundUploadManager.isBusy(cloud.clientDraftId)) {
      Alert.alert('Uploading in the background', 'This draft is uploading in the background. Pause it from the upload bar to edit it, or continue when the upload finishes.');
      return;
    }
    // A paused upload of the local copy refers to the photos about to be
    // replaced; it must not be resumable from the upload bar afterwards.
    if (cloud.clientDraftId) backgroundUploadManager.forget(cloud.clientDraftId);
    const local = await AutoSaveService.saveCloudDraftSnapshot({
      id: cloud.clientDraftId,
      cloudId: cloud.id || cloud._id,
      type: cloud.type,
      title: cloud.title,
      contractNo: cloud.contractNo,
      normalizedContractNo: cloud.normalizedContractNo,
      formData: cloud.formData,
      lots: hydrateCloudLots(cloud),
      activeLotIdx: cloud.activeLotIdx || 0,
      createdAt: cloud.createdAt,
      updatedAt: cloud.updatedAt,
    });
    // The restored draft references R2 URLs, so any older local byte cache is
    // no longer needed and cannot become a competing source of image order.
    await AutoSaveService.deleteDraftMedia(local.id);
    await loadData(false);
    onContinueDraft(local.id, local.type);
  }, [loadData, onContinueDraft]);

  const deleteItem = useCallback((item: UnifiedDraftItem) => {
    if (item.source === 'local' && backgroundUploadManager.isBusy(item.draft.id)) {
      Alert.alert('Uploading in the background', 'This draft is uploading in the background. Pause it from the upload bar before deleting it.');
      return;
    }
    const title = item.title || 'draft';
    Alert.alert('Delete Draft', `Delete "${title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (item.source === 'local') {
            if (backgroundUploadManager.isBusy(item.draft.id)) return;
            // A paused background upload of this draft must not be resumable once it is gone.
            backgroundUploadManager.forget(item.draft.id);
            if (item.draft.cloudId) {
              await reportDraftService.delete(item.draft.cloudId).catch(() => undefined);
            }
            await AutoSaveService.deleteDraft(item.draft.id);
          } else if (item.source === 'cloud') {
            await reportDraftService.delete(item.cloud.id || item.cloud._id || '');
          } else if (item.source === 'queue') {
            await OfflineQueueService.deleteJob(item.job.id);
          } else {
            await api.delete(`/saved-inputs/${item.savedInput._id}`);
          }
          await loadData(false);
        },
      },
    ]);
  }, [loadData]);

  const renderMeta = (counts: { lots: number; images: number; videos: number }) => (
    <View style={styles.metaRow}>
      <View style={styles.metaPill}>
        <Feather name="layers" size={13} color="#64748B" />
        <Text style={styles.metaText}>{counts.lots} lots</Text>
      </View>
      <View style={styles.metaPill}>
        <Feather name="image" size={13} color="#64748B" />
        <Text style={styles.metaText}>{counts.images} images</Text>
      </View>
      {counts.videos > 0 ? (
        <View style={styles.metaPill}>
          <Feather name="video" size={13} color="#64748B" />
          <Text style={styles.metaText}>{counts.videos} videos</Text>
        </View>
      ) : null}
    </View>
  );

  const statusStyle = (status: UnifiedDraftItem['status']) => {
    if (status === 'Cloud saved') return { bg: '#D1FAE5', color: '#059669' };
    if (status === 'Failed') return { bg: '#FEE2E2', color: '#DC2626' };
    if (status === 'Syncing' || status === 'Uploading') return { bg: '#DBEAFE', color: '#2563EB' };
    if (status === 'Waiting to upload') return { bg: '#FEF3C7', color: '#B45309' };
    return { bg: '#F1F5F9', color: '#475569' };
  };

  const renderItem = (item: UnifiedDraftItem) => {
    const cfg = typeConfig[item.type];
    const status = statusStyle(item.status);
    const recoverableQueueError =
      item.source === 'queue' && isRecoverableQueueError(item.job);
    const recoverableDraftError =
      item.source === 'local' && isRecoverableDraftCloudError(item.draft);
    const busy =
      item.status === 'Syncing' ||
      item.status === 'Uploading' ||
      (item.source === 'local' && sendingIds.has(item.draft.id)) ||
      (item.source === 'queue' && sendingIds.has(item.job.id));
    // Live status from the background upload line; a draft it is sending or
    // holding in line cannot be deleted (the bar's Pause comes first).
    const background = item.source === 'local' ? backgroundUploadManager.statusFor(item.draft.id) : undefined;
    const uploadingInBackground = item.source === 'local' && backgroundUploadManager.isBusy(item.draft.id);

    return (
      <View key={item.id} style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.typeIcon, { backgroundColor: cfg.soft }]}>
            <Feather name={cfg.icon as any} size={18} color={cfg.color} />
          </View>
          <View style={styles.cardTitleWrap}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.cardSubtitle}>
              {cfg.label} - {formatDate(item.updatedAt)}
            </Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
            <Text style={[styles.statusText, { color: status.color }]}>{item.status}</Text>
          </View>
        </View>

        <Text style={styles.contractText}>Contract: {item.contractNo || '-'}</Text>
        {renderMeta(item.counts)}

        {background ? (
          <View style={[styles.errorBox, background.status === 'attention' ? styles.retryBox : styles.backgroundBox]}>
            <Feather
              name={background.status === 'attention' ? 'alert-triangle' : 'upload-cloud'}
              size={14}
              color={background.status === 'attention' ? '#B45309' : '#2563EB'}
            />
            <Text
              style={[styles.errorText, background.status === 'attention' ? styles.retryText : styles.backgroundText]}
              accessibilityLiveRegion="polite"
            >
              Background upload: {describeBackgroundUpload(background)}
            </Text>
          </View>
        ) : null}

        {item.source === 'local' && item.draft.cloudSyncError ? (
          <View style={[styles.errorBox, recoverableDraftError && styles.retryBox]}>
            <Feather
              name={recoverableDraftError ? 'wifi-off' : 'alert-triangle'}
              size={14}
              color={recoverableDraftError ? '#B45309' : '#DC2626'}
            />
            <Text
              style={[styles.errorText, recoverableDraftError && styles.retryText]}
              numberOfLines={3}
            >
              {getDraftCloudSyncMessage(item.draft)}
            </Text>
          </View>
        ) : null}

        {item.source === 'queue' && item.job.lastError ? (
          <View style={[styles.errorBox, recoverableQueueError && styles.retryBox]}>
            <Feather
              name={recoverableQueueError ? "wifi-off" : "alert-triangle"}
              size={14}
              color={recoverableQueueError ? "#B45309" : "#DC2626"}
            />
            <Text
              style={[styles.errorText, recoverableQueueError && styles.retryText]}
              numberOfLines={3}
            >
              {item.job.lastError}
            </Text>
          </View>
        ) : null}

        {item.source === 'queue' && !item.job.lastError && !online ? (
          <View style={[styles.errorBox, styles.retryBox]}>
            <Feather
              name={connectionStatus === 'offline' ? 'wifi-off' : 'alert-circle'}
              size={14}
              color="#B45309"
            />
            <Text style={[styles.errorText, styles.retryText]} numberOfLines={3}>
              {connectionStatus === 'offline'
                ? 'Waiting for internet. This report remains on this device. Connect and tap Resume upload.'
                : 'The server cannot be reached. Your report remains on this device; tap Resume upload when ready.'}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          {item.source === 'local' ? (
            <>
              <TouchableOpacity
                style={[styles.primaryAction, { backgroundColor: cfg.color }]}
                onPress={() =>
                  item.cloud && isDraftCloudClean(item.draft, item.cloud)
                    ? continueCloudDraft(item.cloud)
                    : onContinueDraft(item.draft.id, item.draft.type)
                }
                activeOpacity={0.88}
              >
                <Feather name="edit-3" size={15} color="#FFFFFF" />
                <Text style={styles.primaryActionText}>Continue</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryAction, busy && styles.actionDisabled]}
                onPress={() => submitLocalDraft(item.draft)}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator size="small" color="#2563EB" />
                ) : (
                  <Feather name="send" size={15} color="#2563EB" />
                )}
                <Text style={styles.sendText}>Submit</Text>
              </TouchableOpacity>
            </>
          ) : item.source === 'cloud' ? (
            <TouchableOpacity
              style={[styles.primaryAction, { backgroundColor: cfg.color }]}
              onPress={() => continueCloudDraft(item.cloud)}
              activeOpacity={0.88}
            >
              <Feather name="download-cloud" size={15} color="#FFFFFF" />
              <Text style={styles.primaryActionText}>Continue</Text>
            </TouchableOpacity>
          ) : item.source === 'queue' ? (
            <TouchableOpacity
              style={[styles.primaryAction, { backgroundColor: online ? cfg.color : '#94A3B8' }]}
              onPress={() => sendQueued(item.job)}
              activeOpacity={0.88}
              disabled={!online || busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Feather name="upload-cloud" size={15} color="#FFFFFF" />
              )}
              <Text style={styles.primaryActionText}>Send</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.primaryAction, { backgroundColor: cfg.color }]}
              onPress={() => onLoadSavedInput?.(item.savedInput)}
              activeOpacity={0.88}
            >
              <Feather name="file-text" size={15} color="#FFFFFF" />
              <Text style={styles.primaryActionText}>Load</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.secondaryAction, uploadingInBackground && styles.actionDisabled]}
            onPress={() => deleteItem(item)}
            disabled={uploadingInBackground}
            accessibilityRole="button"
            accessibilityState={{ disabled: uploadingInBackground }}
          >
            <Feather name="trash-2" size={15} color="#DC2626" />
            <Text style={styles.deleteText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const showSyncAll = online && unsyncedDrafts.length > 0;
  const showSendReady = online && jobs.length > 0;
  const connectionLabel = connectionStatus === 'online'
    ? 'Online'
    : connectionStatus === 'offline'
      ? 'Offline'
      : connectionStatus === 'server_unreachable'
        ? 'Server unavailable'
        : 'Checking connection';
  const connectionWarning = connectionStatus === 'server_unreachable' || connectionStatus === 'unknown';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#E11D48" />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.heroGlow} />
          <View style={styles.heroContent}>
            <View style={styles.heroTop}>
              <View style={styles.heroLeft}>
                <TouchableOpacity onPress={onOpenDrawer} style={styles.menuBtn}>
                  <Feather name="menu" size={22} color="#FFFFFF" />
                </TouchableOpacity>
                <View style={styles.heroTitleSection}>
                  <Text style={styles.heroTitle}>Drafts</Text>
                  <Text style={styles.heroSubtitle}>
                    Offline captures stay on this device until you submit. Only counts and status sync automatically.
                  </Text>
                </View>
              </View>
              <View style={styles.heroActions}>
                {onOpenNotifications ? (
                  <TouchableOpacity onPress={onOpenNotifications} style={styles.notifBtn} activeOpacity={0.85}>
                    <Feather name="bell" size={20} color="#fff" />
                    {unreadCount > 0 ? (
                      <View style={styles.notifBadge}>
                        <Text style={styles.notifBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <View style={styles.heroMetaRow}>
              <View
                style={[
                  styles.onlineBadge,
                  online
                    ? styles.onlineBadgeOk
                    : connectionWarning
                      ? styles.onlineBadgeWarn
                      : styles.onlineBadgeOff,
                ]}
              >
                <Feather
                  name={(online ? 'wifi' : connectionWarning ? 'alert-circle' : 'wifi-off') as any}
                  size={12}
                  color={online ? '#BBF7D0' : connectionWarning ? '#FDE68A' : '#FCA5A5'}
                />
                <Text
                  style={[
                    styles.onlineText,
                    !online && (connectionWarning ? styles.onlineTextWarn : styles.onlineTextOff),
                  ]}
                >
                  {connectionLabel}
                </Text>
              </View>
            </View>

            <View style={styles.heroStats}>
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{totals.total}</Text>
                <Text style={styles.heroStatLabel}>Drafts</Text>
              </View>
              <View style={styles.heroDivider} />
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{totals.local}</Text>
                <Text style={styles.heroStatLabel}>Local</Text>
              </View>
              <View style={styles.heroDivider} />
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{totals.queued}</Text>
                <Text style={styles.heroStatLabel}>Queued</Text>
              </View>
            </View>

            {storageSummary ? (
              <View style={styles.storageRow}>
                <View style={styles.storageTextWrap}>
                  <Text style={styles.storageLabel}>Offline media storage</Text>
                  <Text style={styles.storageValue}>
                    {storageSummary.formatted} used - {storageSummary.images} images
                    {storageSummary.videos ? `, ${storageSummary.videos} videos` : ''}
                  </Text>
                  <Text style={styles.storageAvailable}>
                    Device available: {storageSummary.availableFormatted || 'Unknown'}
                    {storageSummary.totalFormatted ? ` of ${storageSummary.totalFormatted}` : ''}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.cleanBtn}
                  onPress={cleanCompletedStorage}
                  activeOpacity={0.85}
                >
                  <Feather name="trash-2" size={13} color="#FFFFFF" />
                  <Text style={styles.cleanBtnText}>Free up</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>

        {showSyncAll || showSendReady ? (
          <View style={styles.topActions}>
            {showSyncAll ? (
              <TouchableOpacity
                style={[styles.topAction, syncing && styles.actionDisabled]}
                onPress={syncAll}
                disabled={syncing}
              >
                {syncing ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Feather name="cloud" size={16} color="#FFFFFF" />}
                <Text style={styles.topActionText}>Sync All</Text>
              </TouchableOpacity>
            ) : null}
            {showSendReady ? (
              <TouchableOpacity
                style={[styles.topAction, styles.topActionGreen, syncing && styles.actionDisabled]}
                onPress={sendAll}
                disabled={syncing}
              >
                {syncing ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Feather name="upload-cloud" size={16} color="#FFFFFF" />}
                <Text style={styles.topActionText}>Send Ready</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <OfflineCaptureList onOpen={onContinueDraft} />
        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator size="large" color="#E11D48" />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Feather name="file-plus" size={30} color="#E11D48" />
            </View>
            <Text style={styles.emptyTitle}>No drafts yet</Text>
            <Text style={styles.emptyText}>
              Start a report while online or offline. Saved work will appear here in one list.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>{items.map(renderItem)}</View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 36,
  },
  hero: {
    backgroundColor: '#F43F5E',
    borderRadius: 22,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#F43F5E',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  heroGlow: {
    position: 'absolute',
    top: -50,
    right: -50,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  heroContent: {
    padding: 16,
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  heroLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    marginRight: 14,
  },
  heroTitleSection: {
    flex: 1,
    minWidth: 0,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    marginTop: 2,
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 13,
    lineHeight: 18,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  notifBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#F43F5E',
  },
  notifBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  onlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 10,
    minHeight: 32,
    gap: 5,
    borderWidth: 1,
  },
  onlineBadgeOk: {
    backgroundColor: 'rgba(22, 163, 74, 0.22)',
    borderColor: 'rgba(187, 247, 208, 0.48)',
  },
  onlineBadgeOff: {
    backgroundColor: 'rgba(185, 28, 28, 0.26)',
    borderColor: 'rgba(252, 165, 165, 0.5)',
  },
  onlineBadgeWarn: {
    backgroundColor: 'rgba(161, 98, 7, 0.28)',
    borderColor: 'rgba(253, 230, 138, 0.5)',
  },
  onlineText: {
    color: '#DCFCE7',
    fontSize: 11,
    fontWeight: '900',
  },
  onlineTextOff: {
    color: '#FEE2E2',
  },
  onlineTextWarn: {
    color: '#FEF3C7',
  },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 12,
  },
  storageRow: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  storageTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  storageLabel: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: 11,
    fontWeight: '800',
  },
  storageValue: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  storageAvailable: {
    marginTop: 3,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11,
    fontWeight: '700',
  },
  cleanBtn: {
    minHeight: 34,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  cleanBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  heroStat: {
    flex: 1,
    alignItems: 'center',
  },
  heroStatValue: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
  },
  heroStatLabel: {
    marginTop: 3,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '700',
  },
  heroDivider: {
    width: 1,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  topActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  topAction: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  topActionGreen: {
    backgroundColor: '#0F766E',
  },
  topActionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  loadingState: {
    paddingVertical: 60,
  },
  emptyState: {
    marginTop: 24,
    alignItems: 'center',
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    padding: 28,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 22,
    backgroundColor: '#FFE4E6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '900',
  },
  emptyText: {
    marginTop: 8,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 21,
  },
  list: {
    marginTop: 4,
    gap: 14,
  },
  card: {
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typeIcon: {
    width: 42,
    height: 42,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  cardTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '900',
  },
  cardSubtitle: {
    marginTop: 3,
    color: '#64748B',
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadge: {
    maxWidth: 112,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '900',
  },
  contractText: {
    marginTop: 12,
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
  },
  metaRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  metaText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '800',
  },
  errorBox: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: '#FEF2F2',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  errorText: {
    flex: 1,
    color: '#B91C1C',
    fontSize: 12,
    lineHeight: 17,
  },
  retryBox: {
    backgroundColor: '#FFFBEB',
  },
  retryText: {
    color: '#92400E',
  },
  backgroundBox: {
    backgroundColor: '#EFF6FF',
  },
  backgroundText: {
    color: '#1D4ED8',
  },
  actions: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  primaryAction: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  secondaryAction: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    backgroundColor: '#FFFFFF',
  },
  sendText: {
    color: '#2563EB',
    fontSize: 13,
    fontWeight: '900',
  },
  deleteText: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '900',
  },
  actionDisabled: {
    opacity: 0.65,
  },
});

export default OfflineReportsScreen;
