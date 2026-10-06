import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import NativeAuctionCameraScreen from './NativeAuctionCameraScreen';
import LegacyCameraScreen from './CameraScreen';
import { loadNativeAuctionCamera } from './nativeAuctionCameraModule';
import type { MixedLot } from './types';
import { OfflineCaptureStore } from '../../services/offlineCaptureStore';

jest.mock('../../services/offlineCaptureStore', () => ({ OfflineCaptureStore: {
  getPendingCapture: jest.fn(async () => null),
  stageCameraActivity: jest.fn(async () => undefined),
  acknowledgePendingCapture: jest.fn(async () => true),
} }));

jest.mock('./CameraScreen', () => ({ __esModule: true, default: jest.fn(() => null) }));
jest.mock('./nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));

const openAuctionCamera = jest.fn<Promise<string>, [string?]>();

const originalPlatform = Platform.OS;
const lot: MixedLot = {
  id: 'auctioneer-source-1', mode: 'single_lot', files: [], extraFiles: [], coverIndex: 0,
};
const photo = { uri: 'file:///isolated-new-photo.jpg', name: 'photo.jpg', type: 'image/jpeg' };

function props(lockedStructure?: boolean) {
  return {
    visible: true, lockedStructure, lots: [lot], activeLotIdx: 0, sourceLabels: ['Lot 157'],
    onClose: jest.fn(), setLots: jest.fn(), setActiveLotIdx: jest.fn(), onAutoSave: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(OfflineCaptureStore.stageCameraActivity).mockResolvedValue(undefined);
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera });
  jest.mocked(openAuctionCamera).mockResolvedValue(JSON.stringify([{ ...lot, files: [photo] }]));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await cleanup();
  Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
});

it('acknowledges a durable owner-bound journal only after the draft transaction succeeds', async () => {
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  const input = { ...props(), captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'requested-session' } };
  let finishSave!: () => void;
  input.onAutoSave.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValue(JSON.stringify({ ownerId: 'owner', draftId: 'draft', sessionId: 'recovered-session', revision: 14, lots: [{ ...lot, files: [photo] }] }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onAutoSave).toHaveBeenCalled());
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  await act(async () => { finishSave(); });
  await waitFor(() => expect(acknowledgeCapture).toHaveBeenCalledWith('owner', 'draft', 'recovered-session', 14));
  expect(JSON.parse(openAuctionCamera.mock.calls[0][0] || '{}').captureContext).toEqual(input.captureContext);
});

it('keeps the recovery journal when draft persistence fails', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn();
  const input = { ...props(), captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'session' } };
  input.onAutoSave.mockRejectedValue(new Error('Storage full'));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValue(JSON.stringify({ ...input.captureContext, revision: 1, lots: [{ ...lot, files: [photo] }] }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalled());
  expect(acknowledgeCapture).not.toHaveBeenCalled();
});

it('hands a recorded video back on its original lot with size, MIME and stable photo order', async () => {
  const input = props();
  const clip = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4',
    mediaId: 'stable-video', size: 8_000_000, width: 1280, height: 720 };
  openAuctionCamera.mockResolvedValue(JSON.stringify([
    { ...lot, files: [photo] },
    { ...lot, id: 'second-lot', files: [{ ...photo, name: 'second.jpg' }], videoFile: clip },
  ]));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalled());
  const received = input.setLots.mock.calls[0][0];
  expect(received).toHaveLength(2);
  expect(received[0].videoFile).toBeUndefined();
  expect(received[1].videoFile).toMatchObject(clip);
  expect(received.map((item: MixedLot) => item.files.length)).toEqual([1, 1]);
  expect(input.onAutoSave).toHaveBeenCalledWith(received, 0);
});

it('recovers an interrupted video-only camera handoff without claiming it is a photo', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  const clip = { uri: 'file:///documents/camera-videos/video.mp4', name: 'video.mp4', type: 'video/mp4', size: 8_000_000 };
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'new' };
  const journal = { ...context, sessionId: 'interrupted', revision: 5, lots: [{ ...lot, videoFile: clip }] };
  const getPendingCapture = jest.fn().mockResolvedValue(JSON.stringify(journal));
  const input = { ...props(), visible: false, captureContext: context };
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, getPendingCapture, acknowledgeCapture });
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Recover camera media?', expect.stringContaining('0 photos and 1 video'), expect.any(Array)));
  await act(async () => { alert.mock.calls[0][2]?.find(button => button.text === 'Recover media')?.onPress?.(); });
  await waitFor(() => expect(acknowledgeCapture).toHaveBeenCalledWith('owner', 'draft', 'interrupted', 5));
  expect(input.onAutoSave).toHaveBeenCalledWith([expect.objectContaining({ id: lot.id, files: [], videoFile: expect.objectContaining(clip) })], 0);
});

it('never imports or acknowledges another account journal', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn();
  const input = { ...props(), captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'session' } };
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValue(JSON.stringify({ ownerId: 'other', draftId: 'draft', sessionId: 'session', revision: 1, lots: [{ ...lot, files: [photo] }] }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalled());
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
});

it('offers owner-scoped recovery on a cold draft reopen without opening the camera', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  const getPendingCapture = jest.fn().mockResolvedValue(JSON.stringify({ ownerId: 'owner', draftId: 'draft', sessionId: 'interrupted', revision: 5, lots: [{ ...lot, files: [photo] }] }));
  const input = { ...props(), visible: false, captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'new' } };
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, getPendingCapture, acknowledgeCapture });
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Recover camera photos?', expect.stringContaining('1 photos'), expect.any(Array)));
  expect(openAuctionCamera).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  const recover = alert.mock.calls[0][2]?.find((button) => button.text === 'Recover photos');
  await act(async () => { recover?.onPress?.(); });
  await waitFor(() => expect(acknowledgeCapture).toHaveBeenCalledWith('owner', 'draft', 'interrupted', 5));
  expect(input.onAutoSave).toHaveBeenCalledWith([expect.objectContaining({ id: lot.id })], 0);
});

it('recovers the fallback camera journal on iOS only after the draft save commits', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const recoveredLots = [{ ...lot, files: [{ ...photo, mediaId: 'camera-original', ownership: 'camera' as const }] }];
  const journal = { ...context, revision: 7, lots: recoveredLots };
  jest.mocked(OfflineCaptureStore.getPendingCapture).mockResolvedValueOnce(journal);
  const input = { ...props(), visible: false, captureContext: context };
  let finish!: () => void;
  input.onAutoSave.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(alert).toHaveBeenCalled());
  await act(async () => { alert.mock.calls[0][2]?.find((button) => button.text === 'Recover photos')?.onPress?.(); });
  expect(input.onAutoSave).toHaveBeenCalledWith(recoveredLots, 0);
  expect(OfflineCaptureStore.acknowledgePendingCapture).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  await waitFor(() => expect(OfflineCaptureStore.acknowledgePendingCapture).toHaveBeenCalledWith(journal, 7));
  expect(loadNativeAuctionCamera).not.toHaveBeenCalled();
});

it('does not overwrite photo edits made while the recovery confirmation was open', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn();
  const getPendingCapture = jest.fn().mockResolvedValue(JSON.stringify({ ownerId: 'owner', draftId: 'draft', sessionId: 'interrupted', revision: 5, lots: [{ ...lot, files: [photo] }] }));
  const input = { ...props(), visible: false, captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'new' } };
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, getPendingCapture, acknowledgeCapture });
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(alert).toHaveBeenCalled());
  const recover = alert.mock.calls[0][2]?.find((button) => button.text === 'Recover photos');
  await view.rerender(<NativeAuctionCameraScreen {...input} lots={[{ ...lot, files: [{ ...photo, uri: 'file:///new-user-photo.jpg' }] }]} />);
  await act(async () => { recover?.onPress?.(); });
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(alert).toHaveBeenLastCalledWith('Draft changed', expect.any(String));
});

it('routes fixed source lots to the structure-safe camera without opening legacy native capture', async () => {
  const input = { ...props(true), manualSubmissionRequired: true };
  await render(<NativeAuctionCameraScreen {...input} />);
  expect(openAuctionCamera).not.toHaveBeenCalled();
  expect(loadNativeAuctionCamera).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).toHaveBeenCalled();
  const received = jest.mocked(LegacyCameraScreen).mock.calls[0][0];
  expect(received).toMatchObject({ lockedStructure: true, lots: input.lots, activeLotIdx: 0, sourceLabels: ['Lot 157'], manualSubmissionRequired: true });
  // The same capture/save callbacks retain photos; there is no native-result
  // normalization, rejected setLots, or automatic close on this path.
  expect(received.setLots).toBe(input.setLots);
  expect(received.onAutoSave).toBe(input.onAutoSave);
  expect(received.onClose).toBe(input.onClose);
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onClose).not.toHaveBeenCalled();
});

it.each([undefined, false])('preserves native capture for unlocked work (%s)', async (locked) => {
  const input = props(locked);
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(openAuctionCamera).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(jest.mocked(openAuctionCamera).mock.calls[0][0] || '{}');
  expect(payload.lots).toMatchObject([{ id: lot.id, mode: lot.mode }]);
  expect(input.setLots).toHaveBeenCalledWith([expect.objectContaining({ id: lot.id, files: [expect.objectContaining(photo)] })]);
  expect(input.onAutoSave).toHaveBeenCalledWith([expect.objectContaining({ id: lot.id })], 0);
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
});

it('does not open either camera when the form camera is hidden', async () => {
  await render(<NativeAuctionCameraScreen {...props(true)} visible={false} />);
  expect(openAuctionCamera).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
});

it('passes the same structure lock to the existing non-Android camera', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  await render(<NativeAuctionCameraScreen {...props(true)} />);
  expect(openAuctionCamera).not.toHaveBeenCalled();
  expect(jest.mocked(LegacyCameraScreen).mock.calls[0][0].lockedStructure).toBe(true);
});

it.each(['lock', 'hide', 'unmount'])('does not open a late-resolving native loader after %s', async (change) => {
  let resolveLoader!: (module: { openAuctionCamera: typeof openAuctionCamera }) => void;
  jest.mocked(loadNativeAuctionCamera).mockReturnValue(new Promise((resolve) => { resolveLoader = resolve; }));
  const input = props(false);
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  expect(loadNativeAuctionCamera).toHaveBeenCalledTimes(1);
  if (change === 'unmount') await view.unmount();
  else await view.rerender(<NativeAuctionCameraScreen {...input} visible={change !== 'hide'} lockedStructure={change === 'lock'} />);
  await act(async () => { resolveLoader({ openAuctionCamera }); });
  expect(openAuctionCamera).not.toHaveBeenCalled();
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onClose).not.toHaveBeenCalled();
});

it.each(['hide', 'unmount', 'owner', 'draft', 'lock'])('does not acknowledge or close a stale camera handoff after %s during its draft save', async (change) => {
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let finishSave!: () => void;
  input.onAutoSave.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce(JSON.stringify({ ...context, revision: 2, lots: [{ ...lot, files: [photo] }] }));
  // A newly selected account/draft must never inherit the previous result.
  openAuctionCamera.mockImplementation(() => new Promise<string>(() => {}));
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onAutoSave).toHaveBeenCalledTimes(1));
  expect(view.getByText('Saving camera media...')).toBeTruthy();
  const nextClose = jest.fn();
  const nextSave = jest.fn();
  if (change === 'unmount') await view.unmount();
  else await view.rerender(<NativeAuctionCameraScreen {...input}
    visible={change !== 'hide'}
    lockedStructure={change === 'lock'}
    captureContext={{ ...context,
      ownerId: change === 'owner' ? 'new-owner' : context.ownerId,
      draftId: change === 'draft' ? 'new-draft' : context.draftId,
    }}
    onClose={nextClose} onAutoSave={nextSave} />);
  await act(async () => { finishSave(); });
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(input.onClose).not.toHaveBeenCalled();
  expect(nextClose).not.toHaveBeenCalled();
  expect(nextSave).not.toHaveBeenCalled();
});

// 2026-10-02: after an account or draft change during the camera handoff, the
// screen stayed on "Saving camera media..." (or "Opening camera...") for good,
// which users reported as a frozen camera. It now says what happened and closes
// only when asked; nothing from the old launch reaches the new draft.
it.each(['owner', 'draft'])('explains a camera closed by a %s change during its draft save and closes only when asked', async (change) => {
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let finishSave!: () => void;
  input.onAutoSave.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce(JSON.stringify({ ...context, revision: 2, lots: [{ ...lot, files: [photo] }] }));
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onAutoSave).toHaveBeenCalledTimes(1));
  const nextClose = jest.fn();
  await view.rerender(<NativeAuctionCameraScreen {...input}
    captureContext={{ ...context,
      ownerId: change === 'owner' ? 'new-owner' : context.ownerId,
      draftId: change === 'draft' ? 'new-draft' : context.draftId,
    }}
    onClose={nextClose} />);
  await act(async () => { finishSave(); });
  expect(view.getByText('Camera closed')).toBeTruthy();
  expect(view.queryByText('Saving camera media...')).toBeNull();
  expect(nextClose).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: 'Close camera' }));
  expect(nextClose).toHaveBeenCalledTimes(1);
  expect(input.onClose).not.toHaveBeenCalled();
});

it('explains a camera whose draft changed while it was open, without saving its result into the new draft', async () => {
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let returnResult!: (json: string) => void;
  openAuctionCamera.mockReturnValueOnce(new Promise<string>((resolve) => { returnResult = resolve; }));
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(openAuctionCamera).toHaveBeenCalledTimes(1));
  expect(view.getByText('Opening camera...')).toBeTruthy();
  const nextSave = jest.fn();
  await view.rerender(<NativeAuctionCameraScreen {...input} captureContext={{ ...context, draftId: 'new-draft' }} onAutoSave={nextSave} />);
  await act(async () => { returnResult(JSON.stringify({ ...context, revision: 1, lots: [{ ...lot, files: [photo] }] })); });
  expect(view.getByText('Camera closed')).toBeTruthy();
  expect(view.queryByText('Opening camera...')).toBeNull();
  expect(nextSave).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(input.setLots).not.toHaveBeenCalled();
});

it('clears the closed notice when the camera is hidden and opened again', async () => {
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let returnResult!: (json: string) => void;
  openAuctionCamera.mockReturnValueOnce(new Promise<string>((resolve) => { returnResult = resolve; }));
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(openAuctionCamera).toHaveBeenCalledTimes(1));
  await view.rerender(<NativeAuctionCameraScreen {...input} captureContext={{ ...context, draftId: 'new-draft' }} />);
  await act(async () => { returnResult(JSON.stringify([{ ...lot, files: [photo] }])); });
  expect(view.getByText('Camera closed')).toBeTruthy();
  openAuctionCamera.mockImplementation(() => new Promise<string>(() => {}));
  await view.rerender(<NativeAuctionCameraScreen {...input} visible={false} captureContext={{ ...context, draftId: 'new-draft' }} />);
  await view.rerender(<NativeAuctionCameraScreen {...input} captureContext={{ ...context, draftId: 'new-draft' }} />);
  await waitFor(() => expect(openAuctionCamera).toHaveBeenCalledTimes(2));
  expect(view.queryByText('Camera closed')).toBeNull();
  expect(view.getByText('Opening camera...')).toBeTruthy();
});

it('does not open another camera when same-draft form callbacks rerender during capture', async () => {
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let finishCapture!: (payload: string) => void;
  openAuctionCamera.mockReturnValue(new Promise<string>((resolve) => { finishCapture = resolve; }));
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(openAuctionCamera).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 4; index += 1) {
    await view.rerender(<NativeAuctionCameraScreen {...input} captureContext={{ ...context }}
      lots={[...input.lots]} onClose={() => input.onClose()} onAutoSave={(...args) => input.onAutoSave(...args)} />);
  }
  expect(openAuctionCamera).toHaveBeenCalledTimes(1);
  await act(async () => { finishCapture(JSON.stringify({ ...context, revision: 3, lots: [{ ...lot, files: [photo] }] })); });
  await waitFor(() => expect(acknowledgeCapture).toHaveBeenCalledTimes(1));
  expect(input.onClose).toHaveBeenCalledTimes(1);
  expect(input.onAutoSave).toHaveBeenCalledTimes(1);
  expect(openAuctionCamera).toHaveBeenCalledTimes(1);
});

const cameraLotsFixture = (lotCount: number, totalPhotos: number): MixedLot[] => {
  let photoPosition = 0;
  return Array.from({ length: lotCount }, (_, index) => {
    const count = Math.floor(totalPhotos / lotCount) + (index < totalPhotos % lotCount ? 1 : 0);
    const files = Array.from({ length: count - 2 }, (_, slot) => {
      const position = ++photoPosition;
      const uri = `content://media/external/images/media/${position}`;
      return { uri, originalUri: uri, sourceUri: uri, displayUri: uri, mediaId: `photo-${position}`,
        name: `lot-${index}-photo-${slot}.jpg`, type: 'image/jpeg', captureOrigin: 'camera' as const,
        ownership: 'gallery' as const, captureOrder: position, size: 4_000_000 };
    });
    const extraFiles = Array.from({ length: 2 }, (_, slot) => {
      const position = ++photoPosition;
      const uri = `content://media/external/images/media/${position}`;
      return { uri, originalUri: uri, sourceUri: uri, displayUri: uri, mediaId: `photo-${position}`,
        name: `lot-${index}-extra-${slot}.jpg`, type: 'image/jpeg', captureOrigin: 'camera' as const,
        ownership: 'gallery' as const, captureOrder: position, size: 4_000_000 };
    });
    return { id: `stable-lot-${index}`, lotNumber: `${2500 + index}A`, title: `Saved lot ${index}`,
      mode: 'single_lot' as const, files, extraFiles, coverIndex: Math.min(2, files.length - 1) };
  });
};

it.each([[19, 254], [25, 5000]])('preserves all %i lots and %i original references, photo positions and covers when Done returns', async (lotCount, totalPhotos) => {
  const captured = cameraLotsFixture(lotCount, totalPhotos);
  const context = { ownerId: 'owner', draftId: 'large-draft', sessionId: 'large-session' };
  const input = { ...props(), lots: captured, captureContext: context, activeLotIdx: lotCount - 1 };
  const acknowledgeCapture = jest.fn().mockResolvedValue(true);
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce(JSON.stringify({ ...context, revision: 18, lots: captured }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(openAuctionCamera).toHaveBeenCalledTimes(1);
  const received: MixedLot[] = input.setLots.mock.calls[0][0];
  expect(received).toHaveLength(lotCount);
  expect(received.reduce((count, item) => count + item.files.length + item.extraFiles.length, 0)).toBe(totalPhotos);
  const identities = (lots: MixedLot[]) => lots.map((item) => ({
    id: item.id, lotNumber: item.lotNumber, title: item.title, coverIndex: item.coverIndex,
    files: item.files.map(file => [file.mediaId, file.uri, file.originalUri, file.size, file.captureOrder]),
    extraFiles: item.extraFiles.map(file => [file.mediaId, file.uri, file.originalUri, file.size, file.captureOrder]),
  }));
  expect(identities(received)).toEqual(identities(captured));
  expect(input.onAutoSave).toHaveBeenCalledWith(received, lotCount - 1);
  expect(acknowledgeCapture).toHaveBeenCalledWith(context.ownerId, context.draftId, context.sessionId, 18);
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
});

it.each(['E_RESULT_READ', 'E_RESULT_MISSING', 'E_CAMERA_ALREADY_OPEN', 'E_CAMERA_RESULT', 'E_CAMERA_BUSY'])('retains failed native result %s for recovery and does not start a backup camera over captured work', async (code) => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const input = { ...props(), captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'session' } };
  const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockRejectedValueOnce(Object.assign(new Error('The saved camera result could not be read.'), { code }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(expect.stringMatching(/recover|saved/i), expect.stringMatching(/recover|reopen/i));
});

it('keeps the journal recoverable instead of importing an invalid native result as empty lots', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn();
  const input = { ...props(), captureContext: { ownerId: 'owner', draftId: 'draft', sessionId: 'session' } };
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce('{not-complete-json');
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(expect.stringMatching(/recover/i), expect.stringMatching(/recover/i));
});

it.each([
  ['missing lot manifest', {}],
  ['non-array lot manifest', { lots: 'truncated' }],
  ['null lot', { lots: [null] }],
  ['array instead of lot', { lots: [[]] }],
  ['non-array main photos', { lots: [{ ...lot, files: 'truncated' }] }],
  ['non-array extra photos', { lots: [{ ...lot, extraFiles: 'truncated' }] }],
  ['invalid video', { lots: [{ ...lot, videoFile: {} }] }],
  ['invalid main photo', { lots: [{ ...lot, files: [null] }] }],
  ['invalid extra photo', { lots: [{ ...lot, extraFiles: [{}] }] }],
  ['photo limit overflow', { lots: [{ ...lot, files: Array.from({ length: 200 }, () => photo), extraFiles: [photo] }] }],
])('preserves the camera journal instead of silently accepting %s', async (_description, result) => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce(JSON.stringify({ ...context, revision: 1, ...result }));
  await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(input.setLots).not.toHaveBeenCalled();
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(LegacyCameraScreen).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(expect.stringMatching(/recover/i), expect.stringMatching(/recover/i));
});

it('does not save or acknowledge old captured work after the draft changes while staging camera activity', async () => {
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  const input = { ...props(), captureContext: context };
  let finishStaging!: () => void;
  jest.mocked(OfflineCaptureStore.stageCameraActivity).mockReturnValueOnce(new Promise<void>((resolve) => { finishStaging = resolve; }));
  const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  openAuctionCamera.mockResolvedValueOnce(JSON.stringify({ ...context, revision: 4, lots: [{ ...lot, files: [photo] }] }));
  const view = await render(<NativeAuctionCameraScreen {...input} />);
  await waitFor(() => expect(OfflineCaptureStore.stageCameraActivity).toHaveBeenCalledTimes(1));
  const nextSave = jest.fn();
  const nextClose = jest.fn();
  await view.rerender(<NativeAuctionCameraScreen {...input} captureContext={{ ...context, draftId: 'new-draft' }}
    onAutoSave={nextSave} onClose={nextClose} />);
  await act(async () => { finishStaging(); });
  expect(input.onAutoSave).not.toHaveBeenCalled();
  expect(nextSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
  expect(input.onClose).not.toHaveBeenCalled();
  expect(nextClose).not.toHaveBeenCalled();
});
