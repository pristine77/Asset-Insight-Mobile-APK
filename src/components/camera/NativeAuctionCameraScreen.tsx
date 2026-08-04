import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { normalizePhotoFile } from '../../utils/photoFileUtils';
import LegacyCameraScreen from './CameraScreen';
import { CaptureMode, MixedLot, PhotoFile } from './types';

interface CameraScreenProps {
  visible: boolean;
  onClose: () => void;
  lots: MixedLot[];
  setLots: React.Dispatch<React.SetStateAction<MixedLot[]>>;
  activeLotIdx: number;
  setActiveLotIdx: React.Dispatch<React.SetStateAction<number>>;
  onAutoSave?: (lots?: MixedLot[], activeLotIdx?: number) => void | Promise<void>;
  enhanceImages?: boolean;
  onEnhanceChange?: (enabled: boolean) => void;
}

type NativeAuctionCameraModule = {
  openAuctionCamera: (initialPayload?: string) => Promise<string>;
};

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
    uri,
    originalUri: existing?.originalUri ?? rawSourceUri ?? rawCacheUri ?? rawOriginalUri ?? uri,
    editedUri: existing?.editedUri ?? optionalString(raw.editedUri),
    displayUri: existing?.displayUri ?? rawDisplayUri ?? rawUri ?? uri,
    name: optionalString(raw.name) ?? existing?.name ?? fallbackName,
    type: optionalString(raw.type) ?? existing?.type ?? guessMimeType(uri, fallbackType),
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
      : [];
  const existingByUri = createPhotoLookup(previousLots);

  return rawLots.map((item, lotIndex) => {
    const rawLot = asObject(item) ?? {};
    const id =
      optionalString(rawLot.id) ??
      previousLots[lotIndex]?.id ??
      `lot-${Date.now()}-${lotIndex}`;
    const mode = normalizeMode(rawLot.mode ?? previousLots[lotIndex]?.mode);
    const files = (Array.isArray(rawLot.files) ? rawLot.files : [])
      .map((photo, photoIndex) =>
        normalizeNativePhoto(photo, existingByUri, `lot-${lotIndex + 1}-${photoIndex + 1}.jpg`)
      )
      .filter((photo): photo is PhotoFile => Boolean(photo));
    const extraFiles = (Array.isArray(rawLot.extraFiles) ? rawLot.extraFiles : [])
      .map((photo, photoIndex) =>
        normalizeNativePhoto(
          photo,
          existingByUri,
          `lot-${lotIndex + 1}-extra-${photoIndex + 1}.jpg`
        )
      )
      .filter((photo): photo is PhotoFile => Boolean(photo));
    const cappedFiles = files.slice(0, MAX_ASSET_LOT_PHOTOS);
    const cappedExtraFiles = extraFiles.slice(
      0,
      Math.max(0, MAX_ASSET_LOT_PHOTOS - cappedFiles.length)
    );
    const videoFile = normalizeNativePhoto(
      rawLot.videoFile,
      existingByUri,
      `lot-${lotIndex + 1}-walkthrough.mp4`,
      'video/mp4'
    );
    const coverIndex = Math.max(
      0,
      Math.min(optionalNumber(rawLot.coverIndex) ?? previousLots[lotIndex]?.coverIndex ?? 0, cappedFiles.length - 1)
    );

    return {
      id,
      mode,
      files: cappedFiles,
      extraFiles: cappedExtraFiles,
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
    ...(photo.captureOrder ? { captureOrder: photo.captureOrder } : {}),
    ...(photo.originalOrder ? { originalOrder: photo.originalOrder } : {}),
  };
};

const buildNativePayload = (lots: MixedLot[], activeLotIdx: number) => {
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
    lots: safeLots,
    activeLotIdx: safeActiveIdx,
    activeLotNumber: safeActiveIdx + 1,
  });
};

const loadNativeAuctionCamera = async (): Promise<NativeAuctionCameraModule> => {
  const module = (await import('../../../modules/auction-camera')) as NativeAuctionCameraModule;
  if (typeof module.openAuctionCamera !== 'function') {
    throw new Error('Native auction camera module is not available.');
  }
  return module;
};

const isCancelledError = (error: unknown) => {
  const raw = asObject(error);
  return raw?.code === 'E_CANCELLED';
};

const NativeAuctionCameraScreen: React.FC<CameraScreenProps> = (props) => {
  const { visible, onClose } = props;
  const [useLegacyFallback, setUseLegacyFallback] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const latestPropsRef = useRef(props);
  const launchIdRef = useRef(0);

  latestPropsRef.current = props;

  useEffect(() => {
    if (!visible) {
      launchIdRef.current += 1;
      setLaunching(false);
      setSavingDraft(false);
      setUseLegacyFallback(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== 'android' || useLegacyFallback) return;

    const launchId = launchIdRef.current + 1;
    launchIdRef.current = launchId;
    let disposed = false;

    const launchNativeCamera = async () => {
      setLaunching(true);

      try {
        const current = latestPropsRef.current;
        const payload = buildNativePayload(current.lots, current.activeLotIdx);
        const { openAuctionCamera } = await loadNativeAuctionCamera();
        const json = await openAuctionCamera(payload);

        if (disposed || launchIdRef.current !== launchId) return;

        const parsed = JSON.parse(json);
        const nextLots = normalizeNativeLots(parsed, current.lots);
        const nextActiveIdx =
          nextLots.length > 0
            ? Math.max(0, Math.min(current.activeLotIdx, nextLots.length - 1))
            : 0;

        current.setLots(nextLots);
        current.setActiveLotIdx(nextActiveIdx);

        if (current.onAutoSave) {
          setSavingDraft(true);
          try {
            await current.onAutoSave(nextLots, nextActiveIdx);
          } catch (saveError) {
            console.warn('[Camera] Captured photos could not be saved to draft immediately:', saveError);
            Alert.alert(
              'Draft Save Warning',
              'Photos were captured, but the draft could not be saved immediately. Close the form after it finishes saving.'
            );
          } finally {
            setSavingDraft(false);
          }
        }

        current.onClose();
      } catch (error) {
        if (disposed || launchIdRef.current !== launchId) return;

        if (isCancelledError(error)) {
          latestPropsRef.current.onClose();
          return;
        }

        console.warn('[Camera] Native auction camera unavailable, using fallback:', error);
        Alert.alert('Camera Error', 'Native camera is unavailable. Opening the backup camera.');
        setUseLegacyFallback(true);
      } finally {
        if (!disposed && launchIdRef.current === launchId) {
          setLaunching(false);
        }
      }
    };

    void launchNativeCamera();

    return () => {
      disposed = true;
    };
  }, [useLegacyFallback, visible]);

  if (!visible) return null;

  if (Platform.OS !== 'android' || useLegacyFallback) {
    return <LegacyCameraScreen {...props} />;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.loadingOverlay}>
        <View style={styles.loadingCard}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingTitle}>Opening camera...</Text>
          <Text style={styles.loadingText}>
            {savingDraft
              ? 'Saving captured photos to Drafts.'
              : launching
                ? 'Preparing the native auction camera.'
                : 'Please wait.'}
          </Text>
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
});

export default NativeAuctionCameraScreen;
