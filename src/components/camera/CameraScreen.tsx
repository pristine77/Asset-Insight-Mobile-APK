import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
  usePhotoOutput,
  useVideoOutput,
} from 'react-native-vision-camera';
import type {
  CameraRef,
  CameraSessionConfig,
  Constraint,
  InterruptionReason,
  Recorder,
  Size,
} from 'react-native-vision-camera';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as ScreenOrientation from 'expo-screen-orientation';

import api from '../../services/api';
import { API_BASE_URL } from '../../config/api';
import CaptureButtonsView from './CaptureButtons';
import FocusBox from './FocusBox';
import LotNavigationView from './LotNavigation';
import PhotoThumbnailsView from './PhotoThumbnails';
import RecordButtonView from './RecordButton';
import RecordingIndicatorView from './RecordingIndicator';
import { DoneButton, TopControls } from './TopControls';
import { CaptureMode, MixedLot, PhotoFile, createNewLot } from './types';

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

type FlashMode = 'off' | 'on' | 'auto';
type CameraPerformanceMode = 'speed' | 'balanced' | 'quality';

const DEFAULT_PERFORMANCE_MODE: CameraPerformanceMode = 'quality';
const API_HOST = API_BASE_URL.replace(/\/api\/?$/, '');
const MAX_ASSET_LOT_PHOTOS = 200;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const calcMegapixels = (width?: number, height?: number) => {
  if (!width || !height) return undefined;
  return (width * height) / 1_000_000;
};

const getNeutralZoom = (zoomLensSwitchFactors?: number[]) => {
  const factor = zoomLensSwitchFactors?.[0];
  return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1;
};

const getPhotoTargetResolution = (mode: CameraPerformanceMode): Size => {
  if (mode === 'quality') return CommonResolutions.HIGHEST_4_3;
  if (mode === 'balanced') return CommonResolutions.UHD_4_3;
  return CommonResolutions.FHD_4_3;
};

const getVideoTargetResolution = (mode: CameraPerformanceMode): Size => {
  if (mode === 'quality') return CommonResolutions.UHD_16_9;
  if (mode === 'balanced') return CommonResolutions.FHD_16_9;
  return CommonResolutions.HD_16_9;
};

const getModeLabel = (mode?: CaptureMode) => {
  if (!mode) return 'Not Set';
  if (mode === 'single_lot') return 'Bundle';
  if (mode === 'per_item') return 'Per Item';
  return 'Per Photo';
};

const CameraScreen: React.FC<CameraScreenProps> = ({
  visible,
  onClose,
  lots,
  setLots,
  activeLotIdx,
  setActiveLotIdx,
  onAutoSave,
  enhanceImages = false,
  onEnhanceChange,
}) => {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRecordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimizeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lotsRef = useRef(lots);

  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } =
    useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } =
    useMicrophonePermission();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();

  const wideDevice = useCameraDevice('back', { physicalDevices: ['wide-angle'] });
  const defaultBackDevice = useCameraDevice('back');
  const device = useMemo(() => wideDevice ?? defaultBackDevice, [defaultBackDevice, wideDevice]);

  useEffect(() => {
    lotsRef.current = lots;
  }, [lots]);

  const [performanceMode, setPerformanceMode] =
    useState<CameraPerformanceMode>(DEFAULT_PERFORMANCE_MODE);
  const [flash, setFlash] = useState<FlashMode>('off');
  const [focusOn, setFocusOn] = useState(true);
  const [lowLightBoost, setLowLightBoost] = useState(false);
  const [portraitMode, setPortraitMode] = useState(false);
  const [macroMode, setMacroMode] = useState(false);
  const [enhanceOn, setEnhanceOn] = useState(enhanceImages);
  const [zoom, setZoom] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [videoSessionRequested, setVideoSessionRequested] = useState(false);
  const [cameraConfigured, setCameraConfigured] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const [cameraInterruption, setCameraInterruption] = useState<InterruptionReason | null>(null);
  const [cameraInitAttempts, setCameraInitAttempts] = useState(0);
  const [cameraInitTimedOut, setCameraInitTimedOut] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [selectedPreviewIdx, setSelectedPreviewIdx] = useState(0);
  const [focusBoxRect, setFocusBoxRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [tapFocusPoint, setTapFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [cameraViewSize, setCameraViewSize] = useState(() => {
    const window = Dimensions.get('window');
    return { width: window.width, height: window.height };
  });

  const photoTargetResolution = useMemo(
    () => getPhotoTargetResolution(performanceMode),
    [performanceMode]
  );
  const videoTargetResolution = useMemo(
    () => getVideoTargetResolution(performanceMode),
    [performanceMode]
  );
  const photoOutput = usePhotoOutput({
    targetResolution: photoTargetResolution,
    containerFormat: 'jpeg',
    quality: performanceMode === 'speed' ? 0.92 : performanceMode === 'balanced' ? 0.96 : 1,
    qualityPrioritization:
      performanceMode === 'speed'
        ? 'speed'
        : performanceMode === 'balanced'
          ? 'balanced'
          : 'quality',
  });
  const videoOutput = useVideoOutput({
    targetResolution: videoTargetResolution,
    targetBitRate:
      performanceMode === 'speed'
        ? 12_000_000
        : performanceMode === 'balanced'
          ? 20_000_000
          : 28_000_000,
    enableAudio: hasMicPermission,
  });

  const enableVideoSession = Platform.OS === 'android' ? videoSessionRequested || isRecording : true;
  const outputs = useMemo(
    () => (enableVideoSession ? [photoOutput, videoOutput] : [photoOutput]),
    [enableVideoSession, photoOutput, videoOutput]
  );

  const constraints = useMemo<Constraint[]>(() => {
    if (lowLightBoost) return [{ fps: 24 }, { binned: true }];
    if (performanceMode === 'quality') return [{ fps: 30 }, { binned: false }];
    if (performanceMode === 'balanced') return [{ fps: 30 }];
    return [{ fps: 30 }, { binned: true }];
  }, [lowLightBoost, performanceMode]);

  const neutralZoom = useMemo(() => getNeutralZoom(device?.zoomLensSwitchFactors), [device]);
  const maxZoom = useMemo(() => device?.maxZoom ?? 1, [device]);
  const canUseMacro = useMemo(
    () => (device?.minZoom ?? 1) < neutralZoom - 0.05,
    [device, neutralZoom]
  );
  const zoomPresets = useMemo(() => {
    const presets: { label: string; value: number }[] = [];
    if (canUseMacro) presets.push({ label: 'UW', value: device?.minZoom ?? 1 });
    presets.push({ label: '1x', value: neutralZoom });
    if (maxZoom >= neutralZoom * 2) presets.push({ label: '2x', value: neutralZoom * 2 });
    if (maxZoom >= neutralZoom * 3) presets.push({ label: '3x', value: neutralZoom * 3 });
    if (maxZoom >= neutralZoom * 5) presets.push({ label: '5x', value: neutralZoom * 5 });
    return presets.map((preset) => ({
      ...preset,
      value: clamp(preset.value, device?.minZoom ?? 1, maxZoom),
    }));
  }, [canUseMacro, device, maxZoom, neutralZoom]);

  const currentLot = lots[activeLotIdx];
  const allPhotos = currentLot ? [...currentLot.files, ...currentLot.extraFiles] : [];
  const totalImages = useMemo(
    () => lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0),
    [lots]
  );
  const isLandscape = cameraViewSize.width > cameraViewSize.height;
  const isCameraActive = visible && hasCameraPermission && Boolean(device);

  const cameraStatusMessage = useMemo(() => {
    if (cameraErrorMessage) return `Camera issue: ${cameraErrorMessage}`;
    if (cameraInterruption) return `Camera interrupted: ${cameraInterruption}`;
    if (visible && isCameraActive && (!cameraConfigured || !cameraStarted)) return 'Starting camera...';
    return null;
  }, [cameraConfigured, cameraErrorMessage, cameraInterruption, cameraStarted, isCameraActive, visible]);

  useEffect(() => {
    setEnhanceOn(enhanceImages);
  }, [enhanceImages]);

  useEffect(() => {
    if (!visible) return;
    if (hasCameraPermission) return;
    void requestCameraPermission();
  }, [hasCameraPermission, requestCameraPermission, visible]);

  useEffect(() => {
    if (!visible) {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      StatusBar.setHidden(false);
      return;
    }
    void ScreenOrientation.unlockAsync();
    StatusBar.setHidden(true);
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      StatusBar.setHidden(false);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || lots.length > 0) return;
    setLots([createNewLot()]);
    setActiveLotIdx(0);
  }, [lots.length, setActiveLotIdx, setLots, visible]);

  useEffect(() => {
    if (!visible) return;
    setCameraConfigured(false);
    setCameraStarted(false);
    setCameraErrorMessage(null);
    setCameraInterruption(null);
    setCameraInitAttempts(0);
    setCameraInitTimedOut(false);
    setVideoSessionRequested(false);
    setIsRecording(false);
    setRecordingTime(0);
    setShowPreview(false);
  }, [device?.id, visible]);

  useEffect(() => {
    if (!visible) return;
    setZoom(neutralZoom);
  }, [neutralZoom, visible]);

  useEffect(() => {
    if (!visible || !macroMode || !canUseMacro) return;
    setZoom(clamp(device?.minZoom ?? 1, device?.minZoom ?? 1, maxZoom));
  }, [canUseMacro, device, macroMode, maxZoom, visible]);

  useEffect(() => {
    if (!visible || !hasCameraPermission || device || cameraInitTimedOut) return;
    const timer = setInterval(() => {
      setCameraInitAttempts((previous) => {
        const next = previous + 1;
        if (next >= 10) {
          setCameraInitTimedOut(true);
          clearInterval(timer);
        }
        return next;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [cameraInitTimedOut, device, hasCameraPermission, visible]);

  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (pendingRecordTimeoutRef.current) clearTimeout(pendingRecordTimeoutRef.current);
    };
  }, []);

  const onCameraLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setCameraViewSize({ width, height });
    }
  }, []);

  const ensureMediaPermission = useCallback(async () => {
    if (mediaPermission?.granted) return true;
    const result = await requestMediaPermission();
    return result.granted;
  }, [mediaPermission?.granted, requestMediaPermission]);

  const saveToGallery = useCallback(
    async (uri: string) => {
      const granted = await ensureMediaPermission();
      if (!granted) {
        console.warn('[Camera] Media library permission denied');
        return false;
      }
      try {
        await MediaLibrary.saveToLibraryAsync(uri);
        return true;
      } catch (error) {
        console.warn('[Camera] Failed to save media:', error);
        return false;
      }
    },
    [ensureMediaPermission]
  );

  const queueAutoOptimizePhoto = useCallback(
    (photo: PhotoFile, lotId: string, isExtra: boolean) => {
      optimizeQueueRef.current = optimizeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const formData = new FormData();
            formData.append('lotId', lotId);
            formData.append('type', isExtra ? 'extra' : 'main');
            formData.append('images', {
              uri: photo.uri,
              name: photo.name,
              type: photo.type,
            } as any);

            const uploadResponse = await api.post('/saved-inputs/draft/upload', formData, {
              headers: { 'Content-Type': 'multipart/form-data' },
              timeout: 300000,
            });

            const relativeUrl = uploadResponse.data?.data?.[0]?.url;
            if (typeof relativeUrl !== 'string' || relativeUrl.length === 0) return;

            const sourceUrl = `${API_HOST}${relativeUrl}`;
            const optimizedResponse = await api.get('/gallery/cloudinary-url', {
              params: {
                url: sourceUrl,
                preset: 'highQuality',
              },
            });

            const optimizedUrl = optimizedResponse.data?.url;
            if (typeof optimizedUrl !== 'string' || optimizedUrl.length === 0) return;

            setLots((previous) =>
              previous.map((lot) => {
                if (lot.id !== lotId) return lot;
                return {
                  ...lot,
                  files: isExtra
                    ? lot.files
                    : lot.files.map((item) =>
                      item.uri === photo.uri ? { ...item, displayUri: optimizedUrl } : item
                    ),
                  extraFiles: isExtra
                    ? lot.extraFiles.map((item) =>
                      item.uri === photo.uri ? { ...item, displayUri: optimizedUrl } : item
                    )
                    : lot.extraFiles,
                };
              })
            );
          } catch (error) {
            console.warn('[Camera] Auto enhance failed:', error);
          }
        });
    },
    [setLots]
  );

  const getImageMetaAsync = useCallback(async (uri: string) => {
    return new Promise<{ width?: number; height?: number; megapixels?: number }>((resolve) => {
      Image.getSize(
        uri,
        (width, height) => resolve({ width, height, megapixels: calcMegapixels(width, height) }),
        () => resolve({})
      );
    });
  }, []);

  const computeNormalizedFocusBox = useCallback(
    (imageWidth?: number, imageHeight?: number) => {
      if (!focusOn || !focusBoxRect || !imageWidth || !imageHeight) return undefined;
      const previewWidth = cameraViewSize.width;
      const previewHeight = cameraViewSize.height;
      if (previewWidth <= 0 || previewHeight <= 0) return undefined;

      const x = clamp(focusBoxRect.x / previewWidth, 0, 1);
      const y = clamp(focusBoxRect.y / previewHeight, 0, 1);
      const w = clamp(focusBoxRect.width / previewWidth, 0, 1 - x);
      const h = clamp(focusBoxRect.height / previewHeight, 0, 1 - y);

      return w > 0.01 && h > 0.01 ? { x, y, w, h } : undefined;
    },
    [cameraViewSize.height, cameraViewSize.width, focusBoxRect, focusOn]
  );

  const setPerformance = useCallback(
    (mode: CameraPerformanceMode) => {
      if (isRecording) return;
      setPerformanceMode(mode);
    },
    [isRecording]
  );

  const handleCameraConfigured = useCallback(() => {
    setCameraConfigured(true);
    setCameraErrorMessage(null);
    console.log(`[Camera] Configured device ${device?.id ?? 'unknown'} with ${outputs.length} output(s)`);
  }, [device?.id, outputs.length]);

  const handleCameraStarted = useCallback(() => {
    setCameraStarted(true);
    setCameraErrorMessage(null);
    setCameraInterruption(null);
  }, []);

  const handleCameraStopped = useCallback(() => {
    setCameraStarted(false);
  }, []);

  const handleSessionConfigSelected = useCallback((config: CameraSessionConfig) => {
    console.log(
      `[Camera] Session config selected: fps=${config.selectedFPS ?? 'auto'}, binned=${String(config.isBinned)}, pixelFormat=${config.nativePixelFormat}`
    );
  }, []);

  const handleCameraError = useCallback((error: Error) => {
    console.error('[Camera] Error:', error);
    setCameraErrorMessage(error.message || 'Unknown camera error');
    setCameraStarted(false);
  }, []);

  const handleInterruptionStarted = useCallback((reason: InterruptionReason) => {
    console.warn(`[Camera] Interrupted: ${reason}`);
    setCameraInterruption(reason);
  }, []);

  const handleInterruptionEnded = useCallback(() => {
    setCameraInterruption(null);
    setCameraErrorMessage(null);
  }, []);

  const handlePrevLot = useCallback(() => {
    if (activeLotIdx <= 0) return;
    setActiveLotIdx(activeLotIdx - 1);
  }, [activeLotIdx, setActiveLotIdx]);

  const handleNextLot = useCallback(() => {
    if (activeLotIdx < lots.length - 1) {
      setActiveLotIdx(activeLotIdx + 1);
      return;
    }
    const newLot = createNewLot();
    setLots((previous) => [...previous, newLot]);
    setActiveLotIdx(lots.length);
  }, [activeLotIdx, lots.length, setActiveLotIdx, setLots]);

  const handleFocusAtPoint = useCallback(
    async (x: number, y: number) => {
      if (!focusOn || !cameraRef.current || !cameraConfigured || !cameraStarted) return;
      if (!device?.supportsFocusMetering) return;
      try {
        setTapFocusPoint({ x, y });
        await cameraRef.current.focusTo({ x, y });
        setTimeout(() => setTapFocusPoint(null), 800);
      } catch (error) {
        console.log('[Camera] Focus failed:', error);
      }
    },
    [cameraConfigured, cameraStarted, device?.supportsFocusMetering, focusOn]
  );

  const handleTouchEnd = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      void handleFocusAtPoint(locationX, locationY);
    },
    [handleFocusAtPoint]
  );

  const updateLotsWithCapturedPhoto = useCallback(
    (
      photo: PhotoFile,
      mode: CaptureMode,
      isExtra: boolean,
      lotId?: string
    ) => {
      const nextLots = lotsRef.current.map((lot, index) => {
        if (index !== activeLotIdx) return lot;
        return {
          ...lot,
          id: lotId ?? lot.id,
          mode: isExtra ? lot.mode : mode,
          files: isExtra ? lot.files : [...lot.files, photo],
          extraFiles: isExtra ? [...lot.extraFiles, photo] : lot.extraFiles,
        };
      });
      lotsRef.current = nextLots;
      setLots(nextLots);
      return nextLots;
    },
    [activeLotIdx, setLots]
  );

  const handleCapture = useCallback(
    async (mode: CaptureMode, isExtra: boolean) => {
      if (!cameraConfigured || !cameraStarted) return;
      if (!currentLot) return;

      if (currentLot.mode && currentLot.mode !== mode && !isExtra) {
        Alert.alert(
          'Mode Mismatch',
          `This lot uses "${getModeLabel(currentLot.mode)}". Use Extra or move to a new lot.`
        );
        return;
      }
      if (currentLot.files.length + currentLot.extraFiles.length >= MAX_ASSET_LOT_PHOTOS) {
        Alert.alert(
          'Photo Limit Reached',
          `Lot ${activeLotIdx + 1} already has ${MAX_ASSET_LOT_PHOTOS} photos. Delete photos before capturing more.`
        );
        return;
      }

      if (Platform.OS === 'ios') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Vibration.vibrate(35);
      }

      try {
        const captured = await photoOutput.capturePhotoToFile(
          {
            flashMode: flash === 'on' ? 'on' : 'off',
            enableShutterSound: false,
            enableDepthData: portraitMode && photoOutput.supportsDepthDataDelivery,
            enableDistortionCorrection:
              performanceMode === 'quality' && Boolean(device?.supportsDistortionCorrection),
            enableVirtualDeviceFusion: (device?.physicalDevices?.length ?? 0) > 1,
          },
          {}
        );
        const uri = captured.filePath.startsWith('file://')
          ? captured.filePath
          : `file://${captured.filePath}`;
        const meta = await getImageMetaAsync(uri);
        const photo: PhotoFile = {
          uri,
          originalUri: uri,
          name: `lot-${activeLotIdx + 1}-${Date.now()}.jpg`,
          type: 'image/jpeg',
          width: meta.width,
          height: meta.height,
          megapixels: meta.megapixels,
          focusBox: computeNormalizedFocusBox(meta.width, meta.height),
          timestamp: Date.now(),
          captureOrder: currentLot.files.length + currentLot.extraFiles.length + 1,
        };

        const nextLots = updateLotsWithCapturedPhoto(photo, mode, isExtra, currentLot.id);
        void saveToGallery(uri);
        void onAutoSave?.(nextLots, activeLotIdx);

        if (enhanceOn && currentLot.id) {
          queueAutoOptimizePhoto(photo, currentLot.id, isExtra);
        }
      } catch (error) {
        console.error('[Camera] Photo capture failed:', error);
        Alert.alert('Capture Failed', 'Unable to capture photo. Please try again.');
      }
    },
    [
      activeLotIdx,
      cameraConfigured,
      cameraStarted,
      computeNormalizedFocusBox,
      currentLot,
      device,
      enhanceOn,
      flash,
      getImageMetaAsync,
      onAutoSave,
      performanceMode,
      photoOutput,
      portraitMode,
      queueAutoOptimizePhoto,
      saveToGallery,
      updateLotsWithCapturedPhoto,
    ]
  );

  const clearRecordingState = useCallback(() => {
    recorderRef.current = null;
    setIsRecording(false);
    setVideoSessionRequested(false);
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!cameraConfigured || !cameraStarted) return;
    if (!currentLot?.mode) {
      Alert.alert('Select Mode', 'Capture at least one photo first to set the lot mode.');
      return;
    }
    if (isRecording || recorderRef.current) return;

    if (!hasMicPermission) {
      const granted = await requestMicPermission();
      if (!granted) {
        Alert.alert('Microphone Permission Required', 'Allow microphone access to record video.');
        setVideoSessionRequested(false);
        return;
      }
    }

    if (!enableVideoSession) {
      setVideoSessionRequested(true);
      return;
    }

    try {
      const recorder = await videoOutput.createRecorder({});
      recorderRef.current = recorder;
      setIsRecording(true);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((previous) => previous + 1);
      }, 1000);

      await recorder.startRecording(
        async (filePath: string) => {
          const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
          const videoFile: PhotoFile = {
            uri,
            name: `lot-${activeLotIdx + 1}-video-${Date.now()}.mp4`,
            type: 'video/mp4',
          };
          const nextLots = lotsRef.current.map((lot, index) =>
            index === activeLotIdx
              ? {
                ...lot,
                videoFile,
              }
              : lot
          );
          lotsRef.current = nextLots;
          setLots(nextLots);
          void saveToGallery(uri);
          void onAutoSave?.(nextLots, activeLotIdx);
          clearRecordingState();
        },
        (error: Error) => {
          console.error('[Camera] Recording failed:', error);
          clearRecordingState();
        }
      );
    } catch (error) {
      console.error('[Camera] Failed to start recording:', error);
      clearRecordingState();
      Alert.alert('Recording Failed', 'Unable to start video recording.');
    }
  }, [
    activeLotIdx,
    cameraConfigured,
    cameraStarted,
    clearRecordingState,
    currentLot?.mode,
    enableVideoSession,
    hasMicPermission,
    isRecording,
    onAutoSave,
    requestMicPermission,
    saveToGallery,
    setLots,
    videoOutput,
  ]);

  useEffect(() => {
    if (!visible || !videoSessionRequested || !enableVideoSession || isRecording) return;
    const timer = setTimeout(() => {
      void startRecording();
    }, 250);
    pendingRecordTimeoutRef.current = timer;
    return () => clearTimeout(timer);
  }, [enableVideoSession, isRecording, startRecording, videoSessionRequested, visible]);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;
    try {
      await recorderRef.current.stopRecording();
    } catch (error) {
      console.error('[Camera] Failed to stop recording:', error);
      clearRecordingState();
    }
  }, [clearRecordingState]);

  const toggleFlash = useCallback(() => {
    setFlash((previous) => (previous === 'off' ? 'on' : 'off'));
  }, []);

  const toggleMacroMode = useCallback(() => {
    if (!canUseMacro) return;
    setMacroMode((previous) => {
      const next = !previous;
      setZoom(next ? clamp(device?.minZoom ?? 1, device?.minZoom ?? 1, maxZoom) : neutralZoom);
      return next;
    });
  }, [canUseMacro, device, maxZoom, neutralZoom]);

  const handlePreviewSelect = useCallback((index: number) => {
    setSelectedPreviewIdx(index);
  }, []);

  const previewPhoto = allPhotos[selectedPreviewIdx];
  const portraitPreviewRect = useMemo(() => {
    const width = cameraViewSize.width;
    const height = cameraViewSize.height;

    let previewWidth = width;
    let previewHeight = (previewWidth * 4) / 3;

    if (previewHeight > height) {
      previewHeight = height;
      previewWidth = (previewHeight * 3) / 4;
    }

    return {
      width: previewWidth,
      height: previewHeight,
      left: Math.max(0, (width - previewWidth) / 2),
      top: Math.max(0, (height - previewHeight) / 2),
    };
  }, [cameraViewSize.height, cameraViewSize.width]);

  if (!visible) return null;

  if (!hasCameraPermission) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <SafeAreaView style={styles.permissionContainer}>
          <Feather name="camera-off" size={60} color="#9CA3AF" />
          <Text style={styles.permissionTitle}>Camera Permission Required</Text>
          <Text style={styles.permissionText}>
            Please grant camera access to capture photos for lots.
          </Text>
          <TouchableOpacity
            style={styles.permissionButton}
            onPress={() => {
              void requestCameraPermission();
            }}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => Linking.openSettings()}>
            <Text style={styles.secondaryButtonText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={onClose}>
            <Text style={styles.secondaryButtonText}>Close</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  if (!device) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <SafeAreaView style={styles.permissionContainer}>
          {cameraInitTimedOut ? (
            <>
              <Feather name="camera-off" size={60} color="#EF4444" />
              <Text style={styles.permissionTitle}>No Camera Found</Text>
              <Text style={styles.permissionText}>
                The camera device did not initialize in time. Please close and try again.
              </Text>
              <TouchableOpacity
                style={styles.permissionButton}
                onPress={() => {
                  setCameraInitAttempts(0);
                  setCameraInitTimedOut(false);
                }}>
                <Text style={styles.permissionButtonText}>Try Again</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} onPress={onClose}>
                <Text style={styles.secondaryButtonText}>Close</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.permissionTitle}>Initializing Camera...</Text>
              <Text style={styles.permissionText}>
                Please wait while we set up your camera{cameraInitAttempts > 0 ? ` (${cameraInitAttempts}/10)` : ''}.
              </Text>
            </>
          )}
        </SafeAreaView>
      </Modal>
    );
  }

  if (showPreview && previewPhoto) {
    return (
      <Modal visible={visible} animationType="fade" onRequestClose={() => setShowPreview(false)}>
        <SafeAreaView style={styles.previewContainer}>
          <View style={styles.previewHeader}>
            <TouchableOpacity style={styles.previewHeaderButton} onPress={() => setShowPreview(false)}>
              <Feather name="arrow-left" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.previewTitle}>Captured Media</Text>
            <TouchableOpacity style={styles.previewHeaderButton} onPress={onClose}>
              <Feather name="check" size={22} color="#34D399" />
            </TouchableOpacity>
          </View>
          <Image source={{ uri: previewPhoto.displayUri ?? previewPhoto.uri }} style={styles.previewImage} />
          <ScrollView
            horizontal
            style={styles.previewThumbnails}
            contentContainerStyle={styles.previewThumbnailsContent}
            showsHorizontalScrollIndicator={false}>
            {allPhotos.map((photo, index) => (
              <TouchableOpacity
                key={`${photo.uri}-${index}`}
                style={[
                  styles.previewThumbnail,
                  index === selectedPreviewIdx && styles.previewThumbnailActive,
                ]}
                onPress={() => handlePreviewSelect(index)}>
                <Image
                  source={{ uri: photo.displayUri ?? photo.uri }}
                  style={styles.previewThumbnailImage}
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  }

  const renderCameraView = (cameraStyle: object) => (
    <Camera
      ref={cameraRef}
      style={cameraStyle}
      device={device}
      isActive={isCameraActive}
      outputs={outputs}
      constraints={constraints}
      onConfigured={handleCameraConfigured}
      onSessionConfigSelected={handleSessionConfigSelected}
      onStarted={handleCameraStarted}
      onStopped={handleCameraStopped}
      onError={handleCameraError}
      onInterruptionStarted={handleInterruptionStarted}
      onInterruptionEnded={handleInterruptionEnded}
      getInitialZoom={() => neutralZoom}
      getInitialExposureBias={() => 0}
      zoom={cameraConfigured && cameraStarted ? zoom : undefined}
      enableNativeZoomGesture={false}
      torchMode={flash === 'on' ? 'on' : 'off'}
      enableLowLightBoost={lowLightBoost && Boolean(device.supportsLowLightBoost)}
      enableDistortionCorrection={
        performanceMode === 'quality' && Boolean(device.supportsDistortionCorrection)
      }
    />
  );

  const renderStatusAndFocus = () => (
    <>
      <FocusBox
        visible={focusOn}
        isLandscape={isLandscape}
        viewWidth={cameraViewSize.width}
        viewHeight={cameraViewSize.height}
        onBoxChange={setFocusBoxRect}
      />
      <RecordingIndicatorView isRecording={isRecording} recordingTime={recordingTime} />

      {tapFocusPoint && (
        <View
          pointerEvents="none"
          style={[
            styles.tapFocusIndicator,
            {
              left: tapFocusPoint.x - 32,
              top: tapFocusPoint.y - 32,
            },
          ]}
        />
      )}

      {cameraStatusMessage && (
        <View style={[styles.statusBanner, { top: insets.top + 56 }]}>
          <Text style={styles.statusBannerText}>{cameraStatusMessage}</Text>
        </View>
      )}
    </>
  );

  const performanceButtons = (['speed', 'balanced', 'quality'] as CameraPerformanceMode[]).map(
    (mode) => {
      const active = performanceMode === mode;
      return (
        <TouchableOpacity
          key={mode}
          style={[styles.performanceButton, active && styles.performanceButtonActive]}
          onPress={() => setPerformance(mode)}
          disabled={isRecording}>
          <Text
            style={[styles.performanceButtonText, active && styles.performanceButtonTextActive]}>
            {mode === 'speed' ? 'Speed' : mode === 'balanced' ? 'Balanced' : 'Quality'}
          </Text>
        </TouchableOpacity>
      );
    }
  );

  const performanceButtonsPortrait = (['speed', 'balanced', 'quality'] as CameraPerformanceMode[]).map(
    (mode) => {
      const active = performanceMode === mode;
      return (
        <TouchableOpacity
          key={`portrait-${mode}`}
          style={[
            styles.performanceButton,
            styles.performanceButtonPortrait,
            active && styles.performanceButtonActive,
          ]}
          onPress={() => setPerformance(mode)}
          disabled={isRecording}>
          <Text
            numberOfLines={1}
            style={[styles.performanceButtonText, active && styles.performanceButtonTextActive]}>
            {mode === 'speed' ? 'Speed' : mode === 'balanced' ? 'Balanced' : 'Quality'}
          </Text>
        </TouchableOpacity>
      );
    }
  );

  const modeToggleButtons = (
    <>
      {device.supportsLowLightBoost && (
        <TouchableOpacity
          style={[styles.modeToggle, lowLightBoost && styles.modeToggleActive]}
          onPress={() => setLowLightBoost((previous) => !previous)}>
          <Feather name="moon" size={16} color={lowLightBoost ? '#FCD34D' : '#fff'} />
        </TouchableOpacity>
      )}
      {photoOutput.supportsDepthDataDelivery && (
        <TouchableOpacity
          style={[styles.modeToggle, portraitMode && styles.modeToggleActive]}
          onPress={() => setPortraitMode((previous) => !previous)}>
          <Feather name="user" size={16} color={portraitMode ? '#60A5FA' : '#fff'} />
        </TouchableOpacity>
      )}
      {canUseMacro && (
        <TouchableOpacity
          style={[styles.modeToggle, macroMode && styles.modeToggleActive]}
          onPress={toggleMacroMode}>
          <Feather name="aperture" size={16} color={macroMode ? '#34D399' : '#fff'} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={[styles.modeToggle, enhanceOn && styles.modeToggleActive]}
        onPress={() => {
          const next = !enhanceOn;
          setEnhanceOn(next);
          onEnhanceChange?.(next);
        }}>
        <Feather name="star" size={16} color={enhanceOn ? '#FCD34D' : '#fff'} />
      </TouchableOpacity>
    </>
  );

  const zoomButtons = zoomPresets.map((preset) => {
    const active = Math.abs(zoom - preset.value) < 0.08;
    return (
      <TouchableOpacity
        key={preset.label}
        style={[styles.zoomPresetButton, active && styles.zoomPresetButtonActive]}
        onPress={() => {
          setMacroMode(preset.label === 'UW');
          setZoom(preset.value);
        }}>
        <Text style={[styles.zoomPresetText, active && styles.zoomPresetTextActive]}>
          {preset.label}
        </Text>
      </TouchableOpacity>
    );
  });

  const zoomButtonsPortrait = zoomPresets.map((preset) => {
    const active = Math.abs(zoom - preset.value) < 0.08;
    return (
      <TouchableOpacity
        key={`portrait-${preset.label}`}
        style={[
          styles.zoomPresetButton,
          styles.zoomPresetButtonPortrait,
          active && styles.zoomPresetButtonActive,
        ]}
        onPress={() => {
          setMacroMode(preset.label === 'UW');
          setZoom(preset.value);
        }}>
        <Text
          numberOfLines={1}
          style={[styles.zoomPresetText, active && styles.zoomPresetTextActive]}>
          {preset.label}
        </Text>
      </TouchableOpacity>
    );
  });

  if (!isLandscape) {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        onRequestClose={onClose}
        supportedOrientations={['portrait', 'landscape']}>
        <View style={styles.container}>
          <View
            style={[styles.cameraWrapper, styles.cameraWrapperPortrait43]}
            onLayout={onCameraLayout}
            onTouchEnd={handleTouchEnd}>
            {renderCameraView([
              styles.cameraPortrait43,
              {
                width: portraitPreviewRect.width,
                height: portraitPreviewRect.height,
                left: portraitPreviewRect.left,
                top: portraitPreviewRect.top,
              },
            ])}

            <View style={styles.overlay} pointerEvents="box-none">
              {renderStatusAndFocus()}

              {allPhotos.length > 0 && (
                <View
                  style={[
                    styles.thumbnailOverlay,
                    styles.thumbnailOverlayPortrait,
                    { bottom: insets.bottom + 150 },
                  ]}>
                  <PhotoThumbnailsView
                    photos={allPhotos}
                    onPress={() => {
                      setSelectedPreviewIdx(0);
                      setShowPreview(true);
                    }}
                    compact
                  />
                </View>
              )}

              <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
                <DoneButton onDone={onClose} compact />
                <LotNavigationView
                  lots={lots}
                  activeLotIdx={activeLotIdx}
                  onPrevLot={handlePrevLot}
                  onNextLot={handleNextLot}
                  compact
                />
                <TopControls
                  flash={flash}
                  focusOn={focusOn}
                  onFlashToggle={toggleFlash}
                  onFocusToggle={() => setFocusOn((previous) => !previous)}
                  onDone={onClose}
                  compact
                />
              </View>

              <View style={[styles.bottomBar, styles.bottomBarPortrait, { paddingBottom: insets.bottom + 6 }]}>
                <View style={styles.bottomBarTopRow}>
                  <TouchableOpacity onPress={onClose} style={styles.closeBtnPortrait}>
                    <Feather name="x" size={18} color="#fff" />
                  </TouchableOpacity>

                  <View style={styles.zoomPresetsInline}>{zoomButtonsPortrait}</View>

                  <View style={styles.cameraModeButtons}>{modeToggleButtons}</View>
                </View>

                <View style={styles.performanceRowPortrait}>
                  <View style={styles.performanceButtonsPortrait}>{performanceButtonsPortrait}</View>
                  <RecordButtonView
                    isRecording={isRecording}
                    onStartRecording={() => {
                      void startRecording();
                    }}
                    onStopRecording={() => {
                      void stopRecording();
                    }}
                    disabled={!currentLot?.mode}
                    compact
                  />
                </View>

                <View style={styles.bottomBarRow}>
                  <CaptureButtonsView
                    onCapture={handleCapture}
                    disabled={!cameraConfigured || !cameraStarted}
                  />
                </View>

                <Text style={styles.footerText}>
                  Lot {activeLotIdx + 1} | Main {currentLot?.files.length ?? 0} | Extra{' '}
                  {currentLot?.extraFiles.length ?? 0} | Total {totalImages}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.container}>
        <View style={styles.cameraWrapper} onLayout={onCameraLayout} onTouchEnd={handleTouchEnd}>
          {renderCameraView(StyleSheet.absoluteFillObject)}

          <View style={styles.overlay} pointerEvents="box-none">
            {renderStatusAndFocus()}

            <View
              style={[
                styles.topBarLandscape,
                {
                  paddingTop: Math.max(insets.top, 4),
                  paddingLeft: Math.max(insets.left, 8),
                  paddingRight: Math.max(insets.right, 8) + 118,
                },
              ]}>
              <TouchableOpacity onPress={onClose} style={styles.exitBtnLandscape}>
                <Feather name="x" size={16} color="#fff" />
                <Text style={styles.exitBtnText}>Exit</Text>
              </TouchableOpacity>

              <View style={styles.landscapeCenterInfo}>
                <View style={styles.landscapeCenterInfoRow}>
                  <Text style={styles.landscapeInfoText} numberOfLines={1}>
                    Lot {activeLotIdx + 1} | {currentLot?.files.length ?? 0} main |{' '}
                    {currentLot?.extraFiles.length ?? 0} extra | {getModeLabel(currentLot?.mode)}
                    {isRecording ? ' | REC' : ''}
                  </Text>
                </View>
              </View>

              <View style={styles.landscapeTopControls}>
                <TouchableOpacity onPress={toggleFlash} style={styles.topControlBtn}>
                  <Feather
                    name={flash === 'off' ? 'zap-off' : 'zap'}
                    size={14}
                    color={flash === 'on' ? '#FCD34D' : '#fff'}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setFocusOn((previous) => !previous)}
                  style={[styles.topControlBtn, focusOn && styles.topControlBtnActive]}>
                  <Feather name="crosshair" size={14} color="#fff" />
                </TouchableOpacity>
                {allPhotos.length > 0 && (
                  <TouchableOpacity
                    onPress={() => {
                      setSelectedPreviewIdx(0);
                      setShowPreview(true);
                    }}
                    style={styles.landscapeThumbnailButton}>
                    <Feather name="image" size={14} color="#fff" />
                    <Text style={styles.landscapeThumbnailButtonText}>{allPhotos.length}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <View
              style={[
                styles.rightPanel,
                {
                  top: Math.max(insets.top, 6) + 42,
                  right: Math.max(insets.right, 6),
                  bottom: Math.max(insets.bottom, 6),
                },
              ]}>
              <View style={styles.rightPanelContent}>
                <View style={styles.rightPanelTopGroup}>
                  <View style={styles.zoomPresetsLandscape}>{zoomButtons}</View>
                  <View style={styles.performanceRowLandscape}>{performanceButtons}</View>
                  <View style={styles.cameraModeBtnLandscapeRow}>{modeToggleButtons}</View>

                  <RecordButtonView
                    isRecording={isRecording}
                    onStartRecording={() => {
                      void startRecording();
                    }}
                    onStopRecording={() => {
                      void stopRecording();
                    }}
                    disabled={!currentLot?.mode}
                    compact
                    isLandscape
                  />

                  <CaptureButtonsView
                    onCapture={handleCapture}
                    disabled={!cameraConfigured || !cameraStarted}
                    isLandscape
                  />
                </View>

                <TouchableOpacity onPress={onClose} style={styles.doneBtnLandscapeFull}>
                  <Feather name="check" size={14} color="#fff" />
                  <Text style={styles.doneBtnTextLandscapeFull}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraWrapper: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraWrapperPortrait43: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  cameraPortrait43: {
    position: 'absolute',
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 10,
  },
  topBarLandscape: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    zIndex: 30,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingTop: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    gap: 10,
  },
  bottomBarPortrait: {
    paddingTop: 12,
    paddingHorizontal: 14,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
  },
  bottomBarLandscape: {
    paddingHorizontal: 16,
  },
  bottomBarTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  bottomBarRow: {
    width: '100%',
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomRow: {
    gap: 10,
  },
  bottomRowLandscape: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  zoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  zoomPresetsInline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'nowrap',
    gap: 6,
  },
  zoomPresetsLandscape: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  zoomPresetButton: {
    minWidth: 42,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
  },
  zoomPresetButtonPortrait: {
    flex: 1,
    minWidth: 0,
  },
  zoomPresetButtonActive: {
    backgroundColor: '#FCD34D',
  },
  zoomPresetText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  zoomPresetTextActive: {
    color: '#111827',
  },
  performanceRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  performanceRowPortrait: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  performanceButtonsPortrait: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  performanceRowLandscape: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  performanceButton: {
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
  },
  performanceButtonPortrait: {
    flex: 1,
    minWidth: 0,
  },
  performanceButtonActive: {
    backgroundColor: '#2563EB',
  },
  performanceButtonText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  performanceButtonTextActive: {
    color: '#fff',
  },
  modeToggles: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  cameraModeButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  cameraModeBtnLandscapeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  modeToggle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeToggleActive: {
    backgroundColor: 'rgba(17,24,39,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  captureContainer: {
    paddingBottom: 2,
  },
  footerText: {
    color: '#E5E7EB',
    fontSize: 11,
    textAlign: 'center',
    paddingBottom: 2,
  },
  closeBtnPortrait: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitBtnLandscape: {
    minWidth: 74,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: 'rgba(15,23,42,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  exitBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  landscapeCenterInfo: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  landscapeCenterInfoRow: {
    minHeight: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: 'rgba(15,23,42,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  landscapeInfoText: {
    color: '#F3F4F6',
    fontSize: 12,
    fontWeight: '600',
  },
  landscapeTopControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  topControlBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(15,23,42,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topControlBtnActive: {
    backgroundColor: 'rgba(37,99,235,0.8)',
    borderColor: 'rgba(191,219,254,0.44)',
  },
  landscapeThumbnailButton: {
    minWidth: 42,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 17,
    backgroundColor: 'rgba(15,23,42,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  landscapeThumbnailButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  rightPanel: {
    position: 'absolute',
    width: 126,
    borderRadius: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.76)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
    zIndex: 25,
  },
  rightPanelContent: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 12,
  },
  rightPanelTopGroup: {
    gap: 12,
    alignItems: 'center',
  },
  doneBtnLandscapeFull: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: '#16A34A',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  doneBtnTextLandscapeFull: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  permissionTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 22,
  },
  permissionText: {
    color: '#9CA3AF',
    fontSize: 15,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 24,
    lineHeight: 22,
  },
  permissionButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginBottom: 12,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#D1D5DB',
    fontSize: 15,
  },
  statusBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(17,24,39,0.82)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusBannerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  tapFocusIndicator: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderWidth: 2,
    borderColor: '#FCD34D',
    borderRadius: 10,
    backgroundColor: 'rgba(252,211,77,0.08)',
  },
  thumbnailOverlay: {
    position: 'absolute',
    zIndex: 20,
  },
  thumbnailOverlayPortrait: {
    left: 12,
    bottom: 210,
  },
  thumbnailOverlayLandscape: {
    left: 12,
    bottom: 190,
  },
  previewContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  previewHeaderButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  previewImage: {
    flex: 1,
    width: '100%',
    resizeMode: 'contain',
  },
  previewThumbnails: {
    maxHeight: 90,
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  previewThumbnailsContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewThumbnail: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    marginRight: 10,
  },
  previewThumbnailActive: {
    borderColor: '#2563EB',
  },
  previewThumbnailImage: {
    width: '100%',
    height: '100%',
  },
});

export default CameraScreen;
