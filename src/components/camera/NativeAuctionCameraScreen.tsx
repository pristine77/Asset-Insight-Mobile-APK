import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { normalizePhotoFile } from '../../utils/photoFileUtils';
import LegacyCameraScreen from './CameraScreen';
import { CaptureMode, MixedLot, PhotoFile } from './types';
import { loadNativeAuctionCamera } from './nativeAuctionCameraModule';
import type { CaptureContext } from '../../services/offlineCaptureTypes';
import { OfflineCaptureStore } from '../../services/offlineCaptureStore';

interface CameraScreenProps {
  captureContext?: CaptureContext;
  manualSubmissionRequired?: boolean;
  visible: boolean;
  onClose: () => void;
  lots: MixedLot[];
  setLots: React.Dispatch<React.SetStateAction<MixedLot[]>>;
  activeLotIdx: number;
  setActiveLotIdx: React.Dispatch<React.SetStateAction<number>>;
  onAutoSave?: (lots?: MixedLot[], activeLotIdx?: number) => void | Promise<void>;
  enhanceImages?: boolean;
  onEnhanceChange?: (enabled: boolean) => void;
  lockedStructure?: boolean;
  sourceLabels?: string[];
}

const VALID_MODES = new Set<CaptureMode>(['single_lot', 'per_item', 'per_photo']);
const MAX_ASSET_LOT_PHOTOS = 200;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const optionalString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const isLocalImportableUri = (value?: string) =>
  Boolean(value && (value.startsWith('file://') || value.startsWith('/')));

const pickImportUri = (...values: Array<string | undefined>) =>
  values.find(isLocalImportableUri) ?? values.find(Boolean);

const optionalNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeMode = (value: unknown): CaptureMode =>
  typeof value === 'string' && VALID_MODES.has(value as CaptureMode)
    ? (value as CaptureMode)
    : 'single_lot';

const normalizeFocusBox = (value: unknown): PhotoFile['focusBox'] => {
  const box = asObject(value);
  if (!box) return undefined;

  const x = optionalNumber(box.x);
  const y = optionalNumber(box.y);
  const w = optionalNumber(box.w);
  const h = optionalNumber(box.h);

  return x !== undefined && y !== undefined && w !== undefined && h !== undefined
    ? { x, y, w, h }
    : undefined;
};

const createPhotoLookup = (lots: MixedLot[]) => {
  const lookup = new Map<string, PhotoFile>();

  const add = (photo?: PhotoFile) => {
    if (!photo) return;
    [photo.uri, photo.originalUri, photo.editedUri, photo.displayUri].forEach((uri) => {
      if (uri) lookup.set(uri, photo);
    });
  };

  lots.forEach((lot) => {
    lot.files.forEach(add);
    lot.extraFiles.forEach(add);
    add(lot.videoFile);
  });

  return lookup;
};

const guessMimeType = (uri: string, fallback = 'image/jpeg') => {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return fallback;
};

const normalizeNativePhoto = (
  value: unknown,
  existingByUri: Map<string, PhotoFile>,
  fallbackName: string,
  fallbackType = 'image/jpeg'
): PhotoFile | null => {
  const raw = asObject(value);
  if (!raw) return null;

  const rawUri = optionalString(raw.uri);
  const rawSourceUri = optionalString(raw.sourceUri);
  const rawCacheUri = optionalString(raw.cacheUri);
  const rawOriginalUri = optionalString(raw.originalUri);
  const rawDisplayUri = optionalString(raw.displayUri);
  const uri = pickImportUri(rawSourceUri, rawCacheUri, rawOriginalUri, rawUri, rawDisplayUri);
  if (!uri) return null;

  const existing =
    existingByUri.get(uri) ||
    (rawUri ? existingByUri.get(rawUri) : undefined) ||
    (rawSourceUri ? existingByUri.get(rawSourceUri) : undefined) ||
    (rawCacheUri ? existingByUri.get(rawCacheUri) : undefined);
  const photo = normalizePhotoFile({
    ...existing,
    mediaId: optionalString(raw.mediaId) || existing?.mediaId,
    captureOrigin: raw.captureOrigin === 'camera' ? 'camera' : existing?.captureOrigin,
    ownership: raw.ownership === 'gallery' || raw.ownership === 'camera' ? raw.ownership : existing?.ownership,
    uri,
    originalUri: existing?.originalUri ?? rawSourceUri ?? rawCacheUri ?? rawOriginalUri ?? uri,
    editedUri: existing?.editedUri ?? optionalString(raw.editedUri),
    displayUri: existing?.displayUri ?? rawDisplayUri ?? rawUri ?? uri,
    name: optionalString(raw.name) ?? existing?.name ?? fallbackName,
    type: optionalString(raw.type) ?? existing?.type ?? guessMimeType(uri, fallbackType),
    size: optionalNumber(raw.size) ?? existing?.size,
    width: optionalNumber(raw.width) ?? existing?.width,
    height: optionalNumber(raw.height) ?? existing?.height,
    megapixels: optionalNumber(raw.megapixels) ?? existing?.megapixels,
    focusBox: normalizeFocusBox(raw.focusBox) ?? existing?.focusBox,
    adjustments: existing?.adjustments,
    timestamp: optionalNumber(raw.timestamp) ?? existing?.timestamp,
    captureOrder: optionalNumber(raw.captureOrder) ?? existing?.captureOrder,
    originalOrder: optionalNumber(raw.originalOrder) ?? existing?.originalOrder,
    sourceUri: rawSourceUri ?? existing?.sourceUri ?? uri,
    cacheUri: rawCacheUri ?? existing?.cacheUri,
  });

  return photo;
};

const normalizeNativeLots = (value: unknown, previousLots: MixedLot[]): MixedLot[] => {
  const rawLots = Array.isArray(value)
    ? value
    : Array.isArray(asObject(value)?.lots)
      ? (asObject(value)?.lots as unknown[])
      : null;
  if (!rawLots) throw new Error('Camera returned an incomplete lot manifest.');
  const existingByUri = createPhotoLookup(previousLots);
  const previousById = new Map(previousLots.map((lot) => [lot.id, lot]));

  return rawLots.map((item, lotIndex) => {
    const rawLot = asObject(item);
    if (!rawLot || Array.isArray(item) || (rawLot.files !== undefined && !Array.isArray(rawLot.files)) ||
      (rawLot.extraFiles !== undefined && !Array.isArray(rawLot.extraFiles))) {
      throw new Error('Camera returned an incomplete lot. Keep its journal for recovery.');
    }
    const id =
      optionalString(rawLot.id) ??
      previousLots[lotIndex]?.id ??
      `lot-${Date.now()}-${lotIndex}`;
    const mode = normalizeMode(rawLot.mode ?? previousLots[lotIndex]?.mode);
    const files = (Array.isArray(rawLot.files) ? rawLot.files : [])
      .map((photo, photoIndex) =>
        normalizeNativePhoto(photo, existingByUri, `lot-${lotIndex + 1}-${photoIndex + 1}.jpg`)
      );
    const extraFiles = (Array.isArray(rawLot.extraFiles) ? rawLot.extraFiles : [])
      .map((photo, photoIndex) =>
        normalizeNativePhoto(
          photo,
          existingByUri,
          `lot-${lotIndex + 1}-extra-${photoIndex + 1}.jpg`
        )
      );
    if (files.some((photo) => !photo) || extraFiles.some((photo) => !photo) || files.length + extraFiles.length > MAX_ASSET_LOT_PHOTOS) {
      throw new Error('Camera media is incomplete or exceeds the per-lot limit. Keep its journal for recovery.');
    }
    const normalizedFiles = files as PhotoFile[];
    const normalizedExtraFiles = extraFiles as PhotoFile[];
    const videoFile = normalizeNativePhoto(
      rawLot.videoFile,
      existingByUri,
      `lot-${lotIndex + 1}-walkthrough.mp4`,
      'video/mp4'
    );
    if (rawLot.videoFile != null && !videoFile) throw new Error('Camera returned incomplete video metadata.');
    const coverIndex = Math.max(
      0,
      Math.min(optionalNumber(rawLot.coverIndex) ?? previousLots[lotIndex]?.coverIndex ?? 0, normalizedFiles.length - 1)
    );

    return {
      id,
      lotNumber: previousById.get(id)?.lotNumber,
      title: previousById.get(id)?.title,
      mode,
      files: normalizedFiles,
      extraFiles: normalizedExtraFiles,
      coverIndex: Number.isFinite(coverIndex) ? coverIndex : 0,
      ...(videoFile ? { videoFile } : {}),
    };
  });
};

const serializeNativePhoto = (
  photo: PhotoFile | undefined,
  fallbackName: string,
  fallbackType = 'image/jpeg'
) => {
  if (!photo?.uri) return null;

  return {
    mediaId: photo.mediaId,
    uri: photo.uri,
    originalUri: photo.originalUri ?? photo.uri,
    sourceUri: photo.sourceUri ?? photo.originalUri ?? photo.uri,
    cacheUri: photo.cacheUri,
    displayUri: photo.displayUri ?? photo.editedUri ?? photo.uri,
    name: photo.name ?? fallbackName,
    type: photo.type ?? guessMimeType(photo.uri, fallbackType),
    width: photo.width ?? 0,
    height: photo.height ?? 0,
    megapixels: photo.megapixels ?? 0,
    ...(photo.focusBox ? { focusBox: photo.focusBox } : {}),
    ...(photo.timestamp ? { timestamp: photo.timestamp } : {}),
    ...(photo.captureOrigin ? { captureOrigin: photo.captureOrigin } : {}),
    ...(photo.captureOrder ? { captureOrder: photo.captureOrder } : {}),
    ...(photo.originalOrder ? { originalOrder: photo.originalOrder } : {}),
  };
};

const buildNativePayload = (lots: MixedLot[], activeLotIdx: number, captureContext?: CaptureContext) => {
  const safeActiveIdx = lots.length > 0 ? Math.max(0, Math.min(activeLotIdx, lots.length - 1)) : 0;
  const safeLots = lots.map((lot, index) => {
    const files = (lot.files ?? [])
      .map((photo, photoIndex) =>
        serializeNativePhoto(photo, `lot-${index + 1}-${photoIndex + 1}.jpg`)
      )
      .filter(Boolean);
    const extraFiles = (lot.extraFiles ?? [])
      .map((photo, photoIndex) =>
        serializeNativePhoto(photo, `lot-${index + 1}-extra-${photoIndex + 1}.jpg`)
      )
      .filter(Boolean);
    const videoFile = serializeNativePhoto(
      lot.videoFile,
      `lot-${index + 1}-walkthrough.mp4`,
      'video/mp4'
    );

    return {
      id: lot.id,
      mode: lot.mode ?? 'single_lot',
      files,
      extraFiles,
      ...(videoFile
        ? {
            videoFile: {
              uri: videoFile.uri,
              name: videoFile.name,
              type: videoFile.type,
              timestamp: videoFile.timestamp ?? 0,
            },
          }
        : {}),
      coverIndex: lot.coverIndex ?? 0,
      lotNumber: index + 1,
    };
  });

  return JSON.stringify({
    ...(captureContext ? { captureContext } : {}),
    lots: safeLots,
    activeLotIdx: safeActiveIdx,
    activeLotNumber: safeActiveIdx + 1,
  });
};

const isCancelledError = (error: unknown) => {
  const raw = asObject(error);
  return raw?.code === 'E_CANCELLED';
};

const NativeAuctionCameraScreen: React.FC<CameraScreenProps> = (props) => {
  const { visible, onClose, lockedStructure = false } = props;
  const [useLegacyFallback, setUseLegacyFallback] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  // The account or draft changed while this camera was opening or returning.
  // See launchNativeCamera's stale() below.
  const [contextChanged, setContextChanged] = useState(false);
  const latestPropsRef = useRef(props);
  const launchIdRef = useRef(0);
  const recoveryPromptsRef = useRef(new Set<string>());

  latestPropsRef.current = props;

  useEffect(() => {
    const context = props.captureContext;
    if (visible || !context) return;
    let disposed = false;
    const stillCurrent = () => !disposed && !latestPropsRef.current.visible &&
      latestPropsRef.current.captureContext?.ownerId === context.ownerId &&
      latestPropsRef.current.captureContext?.draftId === context.draftId;
    void (async () => {
      const fallbackJournal = await OfflineCaptureStore.getPendingCapture(context);
      const native = !fallbackJournal && Platform.OS === 'android' ? await loadNativeAuctionCamera() : undefined;
      const raw = fallbackJournal ? JSON.stringify(fallbackJournal) : await native?.getPendingCapture?.(context.ownerId, context.draftId);
      if (!raw || !stillCurrent()) return;
      const journal = JSON.parse(raw);
      if (journal.ownerId !== context.ownerId || journal.draftId !== context.draftId || !Number.isInteger(journal.revision)) return;
      const key = `${fallbackJournal ? 'fallback' : 'native'}:${context.ownerId}:${context.draftId}:${journal.sessionId}:${journal.revision}`;
      if (recoveryPromptsRef.current.has(key)) return;
      recoveryPromptsRef.current.add(key);
      const current = latestPropsRef.current;
      const startingPhotos = JSON.stringify(current.lots);
      const recovered = fallbackJournal ? fallbackJournal.lots as MixedLot[] : normalizeNativeLots(journal, current.lots);
      const count = recovered.reduce((total, lot) => total + lot.files.length + lot.extraFiles.length, 0);
      const videos = recovered.reduce((total, lot) => total + (lot.videoFile ? 1 : 0), 0);
      if (!count && !videos) return;
      Alert.alert(videos ? 'Recover camera media?' : 'Recover camera photos?', `${count} photos${videos ? ` and ${videos} video${videos === 1 ? '' : 's'}` : ''} in ${recovered.length} lots were saved by an interrupted camera session. Recovering restores that media layout; your report details are kept.`, [
        { text: 'Not now', style: 'cancel' },
        { text: videos ? 'Recover media' : 'Recover photos', onPress: () => {
          void (async () => {
            if (!stillCurrent()) return;
            if (JSON.stringify(latestPropsRef.current.lots) !== startingPhotos) {
              Alert.alert('Draft changed', 'Your current photos changed. Reopen this draft to review the camera recovery before replacing them.');
              return;
            }
            try {
              if (!current.onAutoSave) throw new Error('Draft saving is unavailable. Reopen the report form.');
              const index = Math.min(current.activeLotIdx, Math.max(0, recovered.length - 1));
              if (!fallbackJournal) await OfflineCaptureStore.stageCameraActivity(journal);
              await current.onAutoSave(recovered, index);
              if (!stillCurrent()) return;
              current.setLots(recovered);
              current.setActiveLotIdx(index);
              if (fallbackJournal) await OfflineCaptureStore.acknowledgePendingCapture(journal, journal.revision);
              else await native?.acknowledgeCapture?.(context.ownerId, context.draftId, journal.sessionId, journal.revision);
            } catch {
              recoveryPromptsRef.current.delete(key);
              Alert.alert('Photos remain safely recoverable', 'The draft could not be saved. Free device storage if needed, then reopen this draft and recover again.');
            }
          })();
        } },
      ]);
    })().catch(() => { /* Never consume or remove a journal that cannot be read. */ });
    return () => { disposed = true; };
  }, [visible, props.captureContext?.ownerId, props.captureContext?.draftId]);

  useEffect(() => {
    if (!visible) {
      launchIdRef.current += 1;
      setLaunching(false);
      setSavingDraft(false);
      setContextChanged(false);
      setUseLegacyFallback(false);
    }
  }, [visible]);

  useEffect(() => {
    // The legacy Android module can create/rekey/delete lot rows. Fixed upstream
    // lots use the existing JS camera, whose controls preserve their identities.
    if (!visible || Platform.OS !== 'android' || useLegacyFallback || lockedStructure) return;

    const launchId = launchIdRef.current + 1;
    launchIdRef.current = launchId;
    let disposed = false;
    const current = latestPropsRef.current;
    const stillCurrent = () => !disposed && launchIdRef.current === launchId &&
      latestPropsRef.current.visible && !latestPropsRef.current.lockedStructure &&
      latestPropsRef.current.captureContext?.ownerId === current.captureContext?.ownerId &&
      latestPropsRef.current.captureContext?.draftId === current.captureContext?.draftId;

    // When this launch is still the live one and on screen but the account or
    // draft changed underneath it, the early returns below used to leave
    // "Opening camera... Please wait." up for good with no camera behind it.
    // Show what happened and a Close button instead (2026-10-02). The screen is
    // not closed automatically: nothing from this launch may act on the new
    // draft, and the existing tests pin that.
    const stale = () => {
      if (!disposed && launchIdRef.current === launchId && latestPropsRef.current.visible) setContextChanged(true);
    };

    const launchNativeCamera = async () => {
      setLaunching(true);
      setContextChanged(false);
      let receivedResult = false;

      try {
        const payload = buildNativePayload(current.lots, current.activeLotIdx, current.captureContext);
        const { openAuctionCamera, acknowledgeCapture } = await loadNativeAuctionCamera();
        if (!stillCurrent()) return stale();
        const json = await openAuctionCamera(payload);

        if (!stillCurrent()) return stale();
        receivedResult = true;
        setSavingDraft(true);

        const parsed = JSON.parse(json);
        if (current.captureContext && (
          latestPropsRef.current.captureContext?.ownerId !== current.captureContext.ownerId ||
          latestPropsRef.current.captureContext?.draftId !== current.captureContext.draftId ||
          parsed.ownerId !== current.captureContext.ownerId || parsed.draftId !== current.captureContext.draftId
        )) {
          Alert.alert('Capture saved for its original account', 'Reopen the original draft from its owner account to recover these photos.');
          latestPropsRef.current.onClose();
          return;
        }
        const nextLots = normalizeNativeLots(parsed, current.lots);
        const nextActiveIdx =
          nextLots.length > 0
            ? Math.max(0, Math.min(current.activeLotIdx, nextLots.length - 1))
            : 0;

        latestPropsRef.current.setLots(nextLots);
        latestPropsRef.current.setActiveLotIdx(nextActiveIdx);

        if (latestPropsRef.current.onAutoSave) {
          try {
            if (current.captureContext) await OfflineCaptureStore.stageCameraActivity({ ...parsed, ...current.captureContext });
            if (!stillCurrent()) return stale();
            await latestPropsRef.current.onAutoSave?.(nextLots, nextActiveIdx);
            if (!stillCurrent()) return stale();
            if (current.captureContext && typeof parsed.revision === 'number' && typeof parsed.sessionId === 'string') {
              await acknowledgeCapture?.(current.captureContext.ownerId, current.captureContext.draftId, parsed.sessionId, parsed.revision);
            }
          } catch (saveError) {
            if (!stillCurrent()) return stale();
            console.warn('[Camera] Captured photos could not be saved to draft immediately:', saveError);
            Alert.alert(
              'Draft Save Warning',
              'Camera media has not been saved to the draft yet. Keep the originals. Free device storage if needed, then reopen this draft to recover the camera session.'
            );
          }
        }

        if (stillCurrent()) latestPropsRef.current.onClose();
        else stale();
      } catch (error) {
        if (!stillCurrent()) return stale();

        if (isCancelledError(error)) {
          latestPropsRef.current.onClose();
          return;
        }

        const code = asObject(error)?.code;
        if (receivedResult || code === 'E_RESULT_READ' || code === 'E_RESULT_MISSING' || code === 'E_CAMERA_RESULT' || code === 'E_CAMERA_BUSY' || code === 'E_CAMERA_ALREADY_OPEN') {
          // Never start a second camera after a failed return handoff. The
          // durable owner-bound journal is recovered from the original draft.
          Alert.alert('Camera media needs recovery', 'The camera could not return its media to this form. Keep the originals and reopen this draft to recover the saved camera session.');
          latestPropsRef.current.onClose();
          return;
        }

        console.warn('[Camera] Native auction camera unavailable, using fallback:', error);
        Alert.alert('Camera Error', 'Native camera is unavailable. Opening the backup camera.');
        setUseLegacyFallback(true);
      } finally {
        if (!disposed && launchIdRef.current === launchId) {
          setLaunching(false);
          setSavingDraft(false);
        }
      }
    };

    void launchNativeCamera();

    return () => {
      disposed = true;
    };
  }, [lockedStructure, useLegacyFallback, visible]);

  if (!visible) return null;

  if (Platform.OS !== 'android' || useLegacyFallback || lockedStructure) {
    return <LegacyCameraScreen {...props} />;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.loadingOverlay}>
        <View style={styles.loadingCard}>
          {contextChanged ? (
            <>
              <Text style={styles.loadingTitle}>Camera closed</Text>
              <Text style={styles.loadingText}>
                This draft changed while the camera was open. Anything the camera captured stays with the original draft and is offered for recovery when that draft is reopened.
              </Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close camera" onPress={onClose} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>Close</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color="#2563EB" />
              <Text style={styles.loadingTitle}>{savingDraft ? 'Saving camera media...' : 'Opening camera...'}</Text>
              <Text style={styles.loadingText}>
                {savingDraft
                  ? 'Keeping your lots and media in the saved draft.'
                  : launching
                    ? 'Preparing the native auction camera.'
                    : 'Please wait.'}
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  loadingOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  loadingCard: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    borderRadius: 18,
    backgroundColor: '#fff',
    padding: 24,
  },
  loadingTitle: {
    marginTop: 14,
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  loadingText: {
    marginTop: 8,
    fontSize: 14,
    textAlign: 'center',
    color: '#6B7280',
  },
  closeButton: {
    marginTop: 16,
    minHeight: 44,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default NativeAuctionCameraScreen;
