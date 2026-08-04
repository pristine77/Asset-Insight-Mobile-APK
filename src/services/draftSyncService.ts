import { AppState, AppStateStatus } from 'react-native';
import AutoSaveService, { OfflineReportDraft } from './autoSaveService';
import OfflineQueueService from './offlineQueueService';
import reportDraftService from './reportDraftService';

let didInit = false;
let syncing = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;

const isCloudClean = (draft: OfflineReportDraft) => {
  if (!draft.cloudSyncedAt) return false;
  return new Date(draft.cloudSyncedAt).getTime() >= new Date(draft.updatedAt).getTime();
};

async function syncDraft(draft: OfflineReportDraft): Promise<void> {
  try {
    const cloud = await reportDraftService.upsertFromLocalDraft(draft);
    await AutoSaveService.markDraftCloudSynced(draft.id, cloud.id || cloud._id || '');
  } catch (error: any) {
    await AutoSaveService.markDraftCloudSyncError(
      draft.id,
      error?.response?.data?.message || error?.message || 'Cloud sync failed'
    );
  }
}

async function syncOnce(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    if (!(await OfflineQueueService.isOnline())) return;
    const drafts = await AutoSaveService.getDrafts();
    for (const draft of drafts) {
      if (!isCloudClean(draft)) {
        await syncDraft(draft);
      }
    }
  } finally {
    syncing = false;
  }
}

function onAppStateChange(next: AppStateStatus) {
  if (next === 'active') {
    void syncOnce();
  }
}

const DraftSyncService = {
  init(): void {
    if (didInit) return;
    didInit = true;
    void syncOnce();
    syncInterval = setInterval(() => {
      void syncOnce();
    }, 30000);
    appStateSub = AppState.addEventListener('change', onAppStateChange);
  },

  cleanup(): void {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = null;
    appStateSub?.remove();
    appStateSub = null;
    didInit = false;
  },

  syncOnce,
};

export default DraftSyncService;
