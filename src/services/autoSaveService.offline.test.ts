import AutoSaveService from './autoSaveService';
import OfflineCaptureStore from './offlineCaptureStore';
import { LocalMediaStore } from './localMediaStore';
import type { OfflineReportDraft } from './autoSaveService';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/', getInfoAsync: jest.fn() }));
jest.mock('./imageEditService', () => ({ ImageEditService: { isManagedEditedUri: () => false } }));
jest.mock('./localMediaStore', () => ({ LocalMediaStore: {
  setOwner: jest.fn(), getDraftDir: () => 'file:///documents/local_media_store/drafts/owner_draft/',
  getFileInfo: jest.fn(), importMedia: jest.fn(), isManagedUri: () => false,
} }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: {
  setOwner: jest.fn(), getOwnerId: jest.fn(), initialize: jest.fn(), getDraft: jest.fn(),
  saveDraft: jest.fn(), createCloudDraft: jest.fn(), updateDraft: jest.fn(), listDrafts: jest.fn(),
} }));

let saved: Map<string, OfflineReportDraft>;
const photo = (id: number) => ({ uri: `file:///documents/camera-photos/${id}.jpg`, name: `${id}.jpg`, type: 'image/jpeg' });
const form = (id = 'draft', captureMode: 'online' | 'offline' = 'offline') => ({
  id, type: 'asset' as const, captureMode, formData: { contractNo: '', captureMode, clientSubmissionId: `submit-${id}` }, activeLotIdx: 0,
  lots: [{ id: 'lot', mode: 'single_lot' as const, files: [photo(1), photo(2)], extraFiles: [], coverIndex: 0 }],
});
beforeEach(() => {
  jest.clearAllMocks(); saved = new Map();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner');
  jest.mocked(OfflineCaptureStore.getDraft).mockImplementation(async (id) => saved.get(id) || null);
  jest.mocked(OfflineCaptureStore.saveDraft).mockImplementation(async (draft) => { const next = { ...draft, localRevision: (draft.localRevision || 0) + 1 }; saved.set(next.id, next); return next; });
  jest.mocked(OfflineCaptureStore.updateDraft).mockImplementation(async (id, change) => {
    const next = change(saved.get(id)!); saved.set(id, next); return next;
  });
  jest.mocked(OfflineCaptureStore.listDrafts).mockImplementation(async () => [...saved.values()]);
  jest.mocked(LocalMediaStore.getFileInfo).mockResolvedValue({ exists: true, size: 50 });
  jest.mocked(LocalMediaStore.importMedia).mockImplementation(async (args) => ({ mediaId: args.mediaId || `stable-${args.sourceUri}`, uri: args.sourceUri, ownership: 'camera', name: args.name!, type: args.type!, sourceUri: args.sourceUri, createdAt: '2026-09-17T10:00:00Z' }));
});

it('allows a new offline camera draft without a contract but requires a contract online', async () => {
  expect((await AutoSaveService.saveDraft(form())).lots[0].mainImages).toHaveLength(2);
  await expect(AutoSaveService.saveDraft(form('online', 'online'))).rejects.toThrow('Contract number');
});

it('saves separate reports with the same contract without merging identities', async () => {
  const first = form('one'); first.formData.contractNo = '93530';
  const second = form('two'); second.formData.contractNo = '93530';
  await AutoSaveService.saveDraft(first); await AutoSaveService.saveDraft(second);
  expect([...saved.keys()]).toEqual(['one', 'two']);
});

it('keeps missing photo placeholders, their positions and cover selection', async () => {
  jest.mocked(LocalMediaStore.importMedia).mockResolvedValue(null);
  const input = form(); input.lots[0].coverIndex = 1;
  const result = await AutoSaveService.saveDraft(input);
  expect(result.lots[0].mainImages).toHaveLength(2);
  expect(result.lots[0].mainImages[0]).toMatchObject({ uri: photo(1).uri, missing: true, availability: 'missing' });
  expect(result.lots[0].coverIndex).toBe(1);
});

it('serializes competing autosaves for the same draft before reading the prior revision', async () => {
  const first = form(); const second = { ...form(), title: 'Latest user edit' };
  await Promise.all([AutoSaveService.saveDraft(first), AutoSaveService.saveDraft(second)]);
  expect(saved.get('draft')?.title).toBe('Latest user edit');
  expect(OfflineCaptureStore.saveDraft).toHaveBeenCalledTimes(1);
  expect(OfflineCaptureStore.updateDraft).toHaveBeenCalledTimes(1);
});

it('preserves stable photo identities when photos are reordered', async () => {
  await AutoSaveService.saveDraft(form());
  const input = form(); input.lots[0].files.reverse();
  const result = await AutoSaveService.saveDraft(input);
  expect(result.lots[0].mainImages[0]).toMatchObject({ mediaId: `stable-${photo(2).uri}` });
  expect(result.lots[0].mainImages[1]).toMatchObject({ mediaId: `stable-${photo(1).uri}` });
});

it('persists a replacement identity on the same draft without copying or changing its original references', async () => {
  const input = form();
  const first = await AutoSaveService.saveDraft(input);
  const imports = jest.mocked(LocalMediaStore.importMedia).mock.calls.length;
  const next = await AutoSaveService.saveDraft({ ...input, formData: { ...input.formData,
    clientSubmissionId: 'new-submission', supersedesClientSubmissionId: first.formData.clientSubmissionId,
  } });
  expect(next.id).toBe(first.id);
  expect(next.formData).toMatchObject({ clientSubmissionId: 'new-submission', supersedesClientSubmissionId: 'submit-draft' });
  expect(next.lots).toEqual(first.lots);
  expect(LocalMediaStore.importMedia).toHaveBeenCalledTimes(imports);
  expect(saved.size).toBe(1);
});

it.each(['asset', 'lotListing'] as const)('retains %s video references and metadata across repeated offline saves', async type => {
  const clip = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4',
    mediaId: 'stable-video', captureOrder: 7, originalOrder: 7, width: 1280, height: 720, timestamp: 1700000000 };
  const input = { ...form(), type, lots: [{ ...form().lots[0], videoFile: clip }] };
  const first = await AutoSaveService.saveDraft(input);
  const second = await AutoSaveService.saveDraft(input);
  expect(first.lots[0].videoFiles).toHaveLength(1);
  expect(second.lots[0].videoFiles).toEqual(first.lots[0].videoFiles);
  expect(second.lots[0].videoFiles[0]).toMatchObject({ ...clip, slot: 'video', index: 0, lotId: 'lot' });
  expect(second.lots[0].mainImages).toHaveLength(2);
  expect(second.lots[0].extraImages).toHaveLength(0);
  expect(jest.mocked(LocalMediaStore.importMedia).mock.calls.filter(([args]) => args.slot === 'video')).toHaveLength(1);
});

it('never drops the legacy Incoming review gate when a generic form is saved', async () => {
  const input = form();
  const initial = await AutoSaveService.saveDraft(input);
  saved.set('draft', { ...initial, formData: { ...initial.formData, auctioneerWorkItemId: 'work-one', legacyRequiresIncomingReview: true } });
  const result = await AutoSaveService.saveDraft(input);
  expect(result.formData.legacyRequiresIncomingReview).toBe(true);
  expect(result.formData.auctioneerWorkItemId).toBe('work-one');
});

it('fences the original owner before asynchronous storage initialization', async () => {
  let finish!: () => void;
  jest.mocked(OfflineCaptureStore.initialize).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const saving = AutoSaveService.saveDraft(form());
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other-owner');
  finish();
  await expect(saving).rejects.toThrow('account changed');
  expect(LocalMediaStore.importMedia).not.toHaveBeenCalled();
  expect(OfflineCaptureStore.saveDraft).not.toHaveBeenCalled();
});

it('late cloud success and failure cannot mark a newer revision clean or failed', async () => {
  const initial = await AutoSaveService.saveDraft(form());
  const latest = { ...initial, localRevision: 9, title: 'Latest title', cloudSyncError: undefined };
  saved.set(initial.id, latest);
  await AutoSaveService.markDraftCloudSynced(initial.id, 'cloud-id', initial.updatedAt, 'owner', 8);
  await AutoSaveService.markDraftCloudSyncError(initial.id, 'Old upload failed', {
    expectedOwnerId: 'owner', expectedUpdatedAt: initial.updatedAt, expectedLocalRevision: 8,
  });
  expect(saved.get(initial.id)).toEqual(latest);
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other');
  jest.mocked(OfflineCaptureStore.updateDraft).mockClear();
  await AutoSaveService.markDraftCloudSynced(initial.id, 'cloud-id', undefined, 'owner');
  await AutoSaveService.markDraftCloudSyncError(initial.id, 'Old account failed', { expectedOwnerId: 'owner' });
  expect(OfflineCaptureStore.updateDraft).not.toHaveBeenCalled();
});

it('uses owner-bound create-only storage for cloud restoration and never overwrites through saveDraft', async () => {
  const args = {
    ownerId: 'owner', id: 'cloud-only', cloudId: 'server-id', type: 'asset' as const,
    contractNo: '00000', formData: { contractNo: '00000' }, lots: [], activeLotIdx: 0,
  };
  jest.mocked(OfflineCaptureStore.createCloudDraft).mockImplementation(async draft => draft);
  const result = await AutoSaveService.saveCloudDraftSnapshot(args);
  expect(result.id).toBe('cloud-only');
  expect(OfflineCaptureStore.createCloudDraft).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), 'owner');
  expect(OfflineCaptureStore.saveDraft).not.toHaveBeenCalled();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other');
  await expect(AutoSaveService.saveCloudDraftSnapshot(args)).rejects.toThrow('account changed');
  expect(OfflineCaptureStore.createCloudDraft).toHaveBeenCalledTimes(1);
});
