/**
 * Drafts and the background upload line (2026-10-02). A draft the line holds
 * must not be cloud-synced here (that sync replaces the local draft with its
 * cloud copy and deletes its local photos), deleted, or replaced from its
 * cloud copy while it is uploading. The line is real; storage, the cloud and
 * the network are stand-ins.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OfflineReportsScreen from './OfflineReportsScreen';
import AutoSaveService from '../services/autoSaveService';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import reportDraftService from '../services/reportDraftService';
import DraftSyncService from '../services/draftSyncService';
import backgroundUploadManager, { type BackgroundUploadRequest } from '../services/backgroundUploadManager';
import { setUploadOwner } from '../services/uploadCancellation';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#555', warning: '#a50', accent: '#c00', info: '#25e' } }) }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined) } }));
jest.mock('../services/api', () => ({ __esModule: true, default: { get: jest.fn(async () => ({ data: { data: [] } })), delete: jest.fn() } }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: {
  getDraft: jest.fn(), getLocalStorageSummary: jest.fn(async () => ({ bytes: 0, formatted: '0 B', drafts: 0, images: 0, videos: 0 })),
  saveCloudDraftSnapshot: jest.fn(), deleteDraftMedia: jest.fn(async () => undefined), deleteDraft: jest.fn(async () => undefined),
  cleanupOrphanedMedia: jest.fn(async () => 0),
} }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: () => 'owner', listSummaries: jest.fn(), listLegacyDrafts: jest.fn(async () => []), listLegacyJobs: jest.fn(async () => []),
  setSubmissionState: jest.fn(async () => undefined),
} }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: {
  getJobs: jest.fn(async () => []), getConnectivityStatus: jest.fn(async () => ({ status: 'online' })), subscribe: jest.fn(() => () => undefined),
  getSubmissionError: jest.fn(() => ({ title: 'Upload failed', message: 'Retry.' })), retryJob: jest.fn(), retryAll: jest.fn(), deleteJob: jest.fn(),
} }));
jest.mock('../services/reportDraftService', () => ({ __esModule: true, default: { list: jest.fn(async () => []), delete: jest.fn(async () => undefined) } }));
jest.mock('../services/draftSyncService', () => ({ __esModule: true, default: { syncDraft: jest.fn() } }));
jest.mock('../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));

const UPDATED_AT = '2026-10-02T10:00:00.000Z';
/** An Online draft on this device; never saved to the cloud unless cloudSyncedAt is given. */
function localDraft(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, ownerId: 'owner', type: 'asset', title: `Report ${id}`, contractNo: `QA-${id}`, captureMode: 'online', submissionState: 'ready',
    formData: { contractNo: `QA-${id}`, clientSubmissionId: `submission-${id}` },
    lots: [{ id: `${id}-lot`, mode: 'single_lot', mainImages: [{ uri: `file:///drafts/${id}/photo.jpg`, name: 'photo.jpg', type: 'image/jpeg' }], extraImages: [], videoFiles: [], coverIndex: 0 }],
    activeLotIdx: 0, createdAt: UPDATED_AT, updatedAt: UPDATED_AT, ...extra,
  };
}
function showDrafts(...drafts: Array<ReturnType<typeof localDraft>>) {
  jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue(drafts.map((draft) => ({ id: draft.id, type: draft.type, captureMode: 'online' })) as any);
  jest.mocked(AutoSaveService.getDraft).mockImplementation(async (id: string) => (drafts.find((draft) => draft.id === id) || null) as any);
}
/** An upload in the line that never finishes during the test. */
function backgroundUpload(draftId: string) {
  const request: BackgroundUploadRequest = {
    draftId, type: 'asset', ownerId: 'owner', title: `QA-${draftId}`, totalFiles: 1, draft: { id: draftId, ownerId: 'owner' } as any,
    upload: jest.fn(() => new Promise(() => {})),
  };
  return request;
}
const cloudCopy = (draftId: string) => ({ id: `cloud-${draftId}`, clientDraftId: draftId, type: 'asset', title: `Report ${draftId}`, contractNo: `QA-${draftId}`, updatedAt: UPDATED_AT, lots: [], formData: { contractNo: `QA-${draftId}` } });
const synced = (draftId: string) => ({ status: 'synced', cloud: cloudCopy(draftId) });

beforeEach(() => {
  jest.clearAllMocks();
  setUploadOwner('owner');
  backgroundUploadManager.resetForTests();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(reportDraftService.list).mockResolvedValue([]);
  jest.mocked(AutoSaveService.saveCloudDraftSnapshot).mockImplementation(async (args: any) => ({ ...localDraft(args.id), cloudSyncedAt: UPDATED_AT }) as any);
});
afterEach(async () => {
  await cleanup();
  backgroundUploadManager.resetForTests();
  jest.restoreAllMocks();
});

async function openDrafts(onContinueDraft = jest.fn()) {
  await render(<OfflineReportsScreen onOpenDrawer={jest.fn()} onContinueDraft={onContinueDraft} />);
  await waitFor(() => expect(screen.getByText('Report draft-b')).toBeTruthy());
  return onContinueDraft;
}

it('does not cloud-sync, replace or delete the photos of a draft the line holds', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'), localDraft('draft-c'));
  jest.mocked(DraftSyncService.syncDraft).mockImplementation(async (draft: any) => synced(draft.id) as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); backgroundUploadManager.enqueue(backgroundUpload('draft-c')); });
  // draft-a uploading, draft-c waiting in line; pause draft-c so it is held as paused.
  await act(async () => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().queued[0].id); });
  await openDrafts();
  await waitFor(() => expect(DraftSyncService.syncDraft).toHaveBeenCalled());
  expect(jest.mocked(DraftSyncService.syncDraft).mock.calls.map(([draft]) => draft.id)).toEqual(['draft-b']);
  await waitFor(() => expect(AutoSaveService.deleteDraftMedia).toHaveBeenCalledWith('draft-b'));
  // Sync All, which forces a sync of every draft not yet in the cloud, goes
  // through the same rule; it reloads the list when done.
  jest.mocked(DraftSyncService.syncDraft).mockClear();
  const loads = jest.mocked(OfflineCaptureStore.listSummaries).mock.calls.length;
  await fireEvent.press(screen.getByText('Sync All'));
  await waitFor(() => expect(jest.mocked(OfflineCaptureStore.listSummaries).mock.calls.length).toBeGreaterThan(loads));
  expect(DraftSyncService.syncDraft).not.toHaveBeenCalled();
  for (const id of ['draft-a', 'draft-c']) {
    expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalledWith(id);
  }
});

it('keeps the photos of a draft handed to the line while its cloud save was running', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'));
  let finishCloudSave!: () => void;
  jest.mocked(DraftSyncService.syncDraft).mockImplementation((draft: any) => draft.id === 'draft-a'
    ? new Promise((resolve) => { finishCloudSave = () => resolve(synced('draft-a') as any); })
    : Promise.resolve({ status: 'skipped' } as any));
  await openDrafts();
  await waitFor(() => expect(finishCloudSave).toBeDefined());
  // Submit hands the draft over before the cloud save answers.
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  await act(async () => { finishCloudSave(); });
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('shows the live state, and closes Delete while a draft uploads but not once it is paused', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'));
  jest.mocked(DraftSyncService.syncDraft).mockResolvedValue({ status: 'skipped' } as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  await openDrafts();
  expect(screen.getByText('Background upload: Uploading 0 of 1')).toBeTruthy();
  const [deleteA, deleteB] = screen.getAllByRole('button', { name: 'Delete' });
  expect(deleteA.props.accessibilityState?.disabled).toBe(true);
  expect(deleteB.props.accessibilityState?.disabled).toBe(false);
  await fireEvent.press(deleteA);
  expect(Alert.alert).not.toHaveBeenCalled();

  await act(async () => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().active!.id); });
  await waitFor(() => expect(screen.getByText('Background upload: Paused')).toBeTruthy());
  await fireEvent.press(screen.getAllByRole('button', { name: 'Delete' })[0]);
  const confirm = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'Delete Draft')?.[2]?.find((button) => button.text === 'Delete');
  await act(async () => { await confirm?.onPress?.(); });
  expect(AutoSaveService.deleteDraft).toHaveBeenCalledWith('draft-a');
  expect(backgroundUploadManager.statusFor('draft-a')).toBeUndefined();
});

it('refuses to replace a draft from its cloud copy while it uploads', async () => {
  // Saved to the cloud since its last change, so Continue restores the cloud copy.
  showDrafts(localDraft('draft-a', { cloudSyncedAt: UPDATED_AT, cloudId: 'cloud-draft-a' }), localDraft('draft-b', { cloudSyncedAt: UPDATED_AT }));
  jest.mocked(reportDraftService.list).mockResolvedValue([cloudCopy('draft-a')] as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  const onContinueDraft = await openDrafts();
  await fireEvent.press(screen.getAllByText('Continue')[0]);
  expect(Alert.alert).toHaveBeenCalledWith('Uploading in the background', expect.stringContaining('Pause it from the upload bar'));
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  expect(onContinueDraft).not.toHaveBeenCalled();
});
