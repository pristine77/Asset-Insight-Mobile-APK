import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import CameraScreen from '../camera/NativeAuctionCameraScreen';
import { MixedLot, createNewLot } from '../camera/types';
import LotManager from './LotManager';
import lotListingService, { LotListingDetails, LotListingLot } from '../../services/lotListingService';
import AutoSaveService, { AutoSaveData, AutoSaveFormData } from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import { getPhotoUploadUri, normalizePhotoFile } from '../../utils/photoFileUtils';
import { getHiddenCurrentLocation, normalizeHiddenLocation } from '../../utils/mobileLocation';
import type {
  AuctionManagementDestination,
  AuctionManagementServiceItem,
  AuctionManagementTaskPayload,
} from '../../services/auctionManagementService';

interface LotListingFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  draftIdToLoad?: string | null;
  onDraftLoaded?: () => void;
  auctionManagementTask?: AuctionManagementTaskPayload | null;
}

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type ValuationMethod = 'FML' | 'TKV' | 'OLV' | 'FLV';
const LOT_LISTING_VALUATION_METHODS: ValuationMethod[] = ['FML'];

const LotListingFormSheet = ({
  visible,
  onClose,
  onSuccess,
  draftIdToLoad,
  onDraftLoaded,
  auctionManagementTask,
}: LotListingFormSheetProps) => {

  // Form fields
  const [contractNo, setContractNo] = useState('');
  const [salesDate, setSalesDate] = useState(isoDate(new Date()));
  const [location, setLocation] = useState(() => normalizeHiddenLocation().location);
  const [latitude, setLatitude] = useState<number | undefined>(undefined);
  const [longitude, setLongitude] = useState<number | undefined>(undefined);
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(false);
  const [auctionCloseContract, setAuctionCloseContract] = useState(false);
  const [auctionServiceSelections, setAuctionServiceSelections] = useState<Record<number, string[]>>({});

  // Lots with images (using MixedLot type for LotManager compatibility)
  const [lots, setLots] = useState<MixedLot[]>([]);
  const [activeLotIdx, setActiveLotIdx] = useState(0);

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);

  // Details section expanded state (default expanded)
  const [detailsExpanded, setDetailsExpanded] = useState(true);

  // Auto-save state
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [autoSaveInfo, setAutoSaveInfo] = useState<{
    savedAt?: string;
    totalImages?: number;
    totalLots?: number;
  } | null>(null);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const submissionIdRef = useRef<string | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadedDraftIdRef = useRef<string | null>(null);
  const draftSavePromiseRef = useRef<Promise<unknown> | null>(null);
  const isAuctionManagementMode = Boolean(auctionManagementTask);
  const auctionServices = useMemo(() => {
    return (auctionManagementTask?.serviceCatalog || []).flatMap((catalog) =>
      (catalog.services || []).map((service) => ({
        ...service,
        catalogName: catalog.name || catalog.contractCode || 'Services',
      }))
    );
  }, [auctionManagementTask?.serviceCatalog]);
  const auctionServiceById = useMemo(() => {
    return new Map(auctionServices.map((service) => [service.rowGuid, service]));
  }, [auctionServices]);
  const activeSeedLot = auctionManagementTask?.lots?.[activeLotIdx];
  const auctionCustomerName =
    auctionManagementTask?.customer?.name ||
    auctionManagementTask?.customer?.company ||
    'Customer not set';
  const auctionLocationLabel =
    auctionManagementTask?.event?.location ||
    auctionManagementTask?.contract?.saleLocation ||
    auctionManagementTask?.customer?.address ||
    location ||
    'Location not set';

  const clearError = (key: string) => {
    setErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  useEffect(() => {
    if (!visible || !auctionManagementTask) return;
    const eventDate = auctionManagementTask.event?.eventDate || new Date().toISOString();
    const taskLocation = normalizeHiddenLocation(
      auctionManagementTask.event?.location ||
        auctionManagementTask.contract?.saleLocation ||
        auctionManagementTask.customer?.address ||
        undefined
    );
    const seedLots =
      auctionManagementTask.lots.length > 0
        ? auctionManagementTask.lots
        : [{
            id: `${auctionManagementTask.task.rowGuid}:lot:1`,
            label: 'Lot 1',
            source: 'manual',
            lotNumber: '1',
            description: 'Lot 1',
            selectedServiceIds: [],
          }];

    setContractNo(String(auctionManagementTask.contract?.contractNumber || ''));
    setSalesDate(eventDate.slice(0, 10));
    setLocation(taskLocation.location);
    setLatitude(taskLocation.latitude);
    setLongitude(taskLocation.longitude);
    setBankPhotosEnabled(false);
    setLots(seedLots.map((seedLot, index) => ({
      ...createNewLot(),
      id: `auctionsoft-${seedLot.id || index}`,
      mode: 'single_lot',
    })));
    setActiveLotIdx(0);
    setAuctionCloseContract(false);
    setAuctionServiceSelections(
      Object.fromEntries(
        seedLots.map((seedLot, index) => [index, Array.isArray(seedLot.selectedServiceIds) ? seedLot.selectedServiceIds : []])
      )
    );
    setDetailsExpanded(true);
    setErrors({});
  }, [auctionManagementTask, visible]);

  // Keep legacy single autosave recoverable through the Offline Reports page.
  useEffect(() => {
    if (visible && !draftIdToLoad && !auctionManagementTask) {
      void AutoSaveService.migrateLegacyAutoSaveIfNeeded();
    }
  }, [auctionManagementTask, visible, draftIdToLoad]);

  const checkForAutoSave = async () => {
    try {
      const summary = await AutoSaveService.getAutoSaveSummary();
      if (summary.exists && summary.formType === 'lotListing' && summary.totalImages && summary.totalImages > 0) {
        setAutoSaveInfo({
          savedAt: summary.savedAt,
          totalImages: summary.totalImages,
          totalLots: summary.totalLots,
        });
        setShowRestorePrompt(true);
      }
    } catch (error) {
      console.error('Error checking auto-save:', error);
    }
  };

  const handleRestoreAutoSave = async () => {
    try {
      const data = await AutoSaveService.getAutoSave();
      if (data && data.formType === 'lotListing') {
        // Restore form data
        if (data.formData.contractNo) setContractNo(data.formData.contractNo);
        if (data.formData.effectiveDate) setSalesDate(data.formData.effectiveDate);
        if (typeof data.formData.bankPhotosEnabled === 'boolean') {
          setBankPhotosEnabled(data.formData.bankPhotosEnabled);
        }
        if (
          data.formData.location ||
          data.formData.latitude !== undefined ||
          data.formData.longitude !== undefined
        ) {
          const restoredLocation = normalizeHiddenLocation(
            data.formData.location,
            data.formData.latitude,
            data.formData.longitude
          );
          setLocation(restoredLocation.location);
          setLatitude(restoredLocation.latitude);
          setLongitude(restoredLocation.longitude);
        }
        // Restore lots with images
        const restoredLots: MixedLot[] = data.lots.map((savedLot) => ({
          id: savedLot.id,
          mode: savedLot.mode,
          files: savedLot.mainImages.map((file, i) =>
            normalizePhotoFile(
              typeof file === 'string'
                ? {
                    uri: file,
                    originalUri: file,
                    name: `restored-main-${i}.jpg`,
                    type: 'image/jpeg' as const,
                  }
                : {
                    ...file,
                    name: file.name || `restored-main-${i}.jpg`,
                    type: file.type || 'image/jpeg',
                  }
            )
          ),
          extraFiles: savedLot.extraImages.map((file, i) =>
            normalizePhotoFile(
              typeof file === 'string'
                ? {
                    uri: file,
                    originalUri: file,
                    name: `restored-extra-${i}.jpg`,
                    type: 'image/jpeg' as const,
                  }
                : {
                    ...file,
                    name: file.name || `restored-extra-${i}.jpg`,
                    type: file.type || 'image/jpeg',
                  }
            )
          ),
          videoFile:
            savedLot.videoFiles.length > 0
              ? typeof savedLot.videoFiles[0] === 'string'
                ? {
                    uri: savedLot.videoFiles[0],
                    name: 'restored-video.mp4',
                    type: 'video/mp4' as const,
                  }
                : {
                    uri: savedLot.videoFiles[0].uri,
                    name: savedLot.videoFiles[0].name || 'restored-video.mp4',
                    type: savedLot.videoFiles[0].type || 'video/mp4',
                  }
              : undefined,
          coverIndex: savedLot.coverIndex,
        }));

        if (restoredLots.length > 0) {
          setLots(restoredLots);
          setActiveLotIdx(data.activeLotIdx >= 0 ? data.activeLotIdx : 0);
        }

        Alert.alert(
          'Restored',
          `Restored ${data.lots.reduce((sum, l) => sum + l.mainImages.length + l.extraImages.length, 0)} images from ${data.lots.length} lot(s).`
        );
      }
    } catch (error) {
      console.error('Error restoring auto-save:', error);
      Alert.alert('Error', 'Failed to restore saved data.');
    }
    setShowRestorePrompt(false);
  };

  const handleDiscardAutoSave = async () => {
    try {
      await AutoSaveService.deleteAutoSave();
    } catch (error) {
      console.error('Error deleting auto-save:', error);
    }
    setShowRestorePrompt(false);
  };

  const applyStoredDraftData = useCallback(
    (data: Pick<AutoSaveData, 'formData' | 'lots' | 'activeLotIdx'>) => {
      if (data.formData.contractNo) setContractNo(data.formData.contractNo);
      if (data.formData.clientSubmissionId) {
        submissionIdRef.current = data.formData.clientSubmissionId;
      }
      if (data.formData.effectiveDate) setSalesDate(data.formData.effectiveDate);
      if (data.formData.salesDate) setSalesDate(data.formData.salesDate);
      if (typeof data.formData.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.formData.bankPhotosEnabled);
      }
      if (
        data.formData.location ||
        data.formData.latitude !== undefined ||
        data.formData.longitude !== undefined
      ) {
        const restoredLocation = normalizeHiddenLocation(
          data.formData.location,
          data.formData.latitude,
          data.formData.longitude
        );
        setLocation(restoredLocation.location);
        setLatitude(restoredLocation.latitude);
        setLongitude(restoredLocation.longitude);
      }
      const restoredLots: MixedLot[] = data.lots.map((savedLot) => ({
        id: savedLot.id,
        mode: savedLot.mode,
        files: savedLot.mainImages.map((file, i) =>
          normalizePhotoFile(
            typeof file === 'string'
              ? {
                  uri: file,
                  originalUri: file,
                  name: `restored-main-${i}.jpg`,
                  type: 'image/jpeg' as const,
                }
              : {
                  ...file,
                  name: file.name || `restored-main-${i}.jpg`,
                  type: file.type || 'image/jpeg',
                }
          )
        ),
        extraFiles: savedLot.extraImages.map((file, i) =>
          normalizePhotoFile(
            typeof file === 'string'
              ? {
                  uri: file,
                  originalUri: file,
                  name: `restored-extra-${i}.jpg`,
                  type: 'image/jpeg' as const,
                }
              : {
                  ...file,
                  name: file.name || `restored-extra-${i}.jpg`,
                  type: file.type || 'image/jpeg',
                }
          )
        ),
        videoFile:
          savedLot.videoFiles.length > 0
            ? typeof savedLot.videoFiles[0] === 'string'
              ? {
                  uri: savedLot.videoFiles[0],
                  name: 'restored-video.mp4',
                  type: 'video/mp4' as const,
                }
              : {
                  uri: savedLot.videoFiles[0].uri,
                  name: savedLot.videoFiles[0].name || 'restored-video.mp4',
                  type: savedLot.videoFiles[0].type || 'video/mp4',
                }
            : undefined,
        coverIndex: savedLot.coverIndex,
      }));

      if (restoredLots.length > 0) {
        setLots(restoredLots);
        setActiveLotIdx(data.activeLotIdx >= 0 ? data.activeLotIdx : 0);
      }
    },
    []
  );

  useEffect(() => {
    if (!visible || !draftIdToLoad || loadedDraftIdRef.current === draftIdToLoad) return;

    let cancelled = false;
    const loadDraft = async () => {
      try {
        const draft = await AutoSaveService.getDraft(draftIdToLoad);
        if (cancelled || !draft || draft.type !== 'lotListing') return;
        applyStoredDraftData(draft);
        setCurrentDraftId(draft.id);
        loadedDraftIdRef.current = draft.id;
        onDraftLoaded?.();
      } catch (error) {
        console.error('Error loading offline draft:', error);
        Alert.alert('Error', 'Failed to open offline draft.');
      }
    };

    void loadDraft();
    return () => {
      cancelled = true;
    };
  }, [applyStoredDraftData, draftIdToLoad, onDraftLoaded, visible]);

  const buildAutoSaveFormData = useCallback(
    (): AutoSaveFormData => ({
      clientSubmissionId:
        submissionIdRef.current ||
        (submissionIdRef.current = `ll-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
      contractNo,
      effectiveDate: salesDate,
      salesDate,
      location,
      latitude,
      longitude,
      bankPhotosEnabled,
      selectedValuationMethods: LOT_LISTING_VALUATION_METHODS,
    }),
    [bankPhotosEnabled, contractNo, latitude, location, longitude, salesDate]
  );

  const hasDraftableWork = useCallback((candidateLots: MixedLot[] = lots) => {
    const hasImages = candidateLots.some((l) => l.files.length > 0 || l.extraFiles.length > 0 || l.videoFile);
    const hasLots = candidateLots.length > 0;
    const hasDetails = Boolean(contractNo.trim());
    return hasImages || hasLots || hasDetails;
  }, [contractNo, lots]);

  const requireContractNumberForDraft = useCallback(() => {
    if (contractNo.trim()) return true;
    Alert.alert(
      'Contract Number Required',
      'Enter a unique contract number before adding lots, opening the camera, or saving this offline draft.'
    );
    return false;
  }, [contractNo]);

  const saveCurrentDraftNow = useCallback(async (
    lotsSnapshot: MixedLot[] = lots,
    activeLotIdxSnapshot: number = activeLotIdx
  ) => {
    if (!hasDraftableWork(lotsSnapshot) || !contractNo.trim()) return null;

    const savePromise = AutoSaveService.saveDraft({
      id: currentDraftId,
      type: 'lotListing',
      title: contractNo.trim() || 'Lot Listing',
      formData: buildAutoSaveFormData(),
      lots: lotsSnapshot,
      activeLotIdx: activeLotIdxSnapshot,
    });

    draftSavePromiseRef.current = savePromise;
    try {
      const draft = await savePromise;
      if (currentDraftId !== draft.id) setCurrentDraftId(draft.id);
      return draft;
    } finally {
      if (draftSavePromiseRef.current === savePromise) {
        draftSavePromiseRef.current = null;
      }
    }
  }, [activeLotIdx, buildAutoSaveFormData, contractNo, currentDraftId, hasDraftableWork, lots]);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    void getHiddenCurrentLocation().then((snapshot) => {
      if (cancelled) return;
      setLocation((current) => current.trim() || snapshot.location);
      if (snapshot.latitude !== undefined && snapshot.longitude !== undefined) {
        setLatitude((current) => current ?? snapshot.latitude);
        setLongitude((current) => current ?? snapshot.longitude);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Auto-save form data and images
  const triggerAutoSave = useCallback(async (
    lotsSnapshot?: MixedLot[],
    activeLotIdxSnapshot?: number
  ) => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    if (lotsSnapshot) {
      try {
        await saveCurrentDraftNow(lotsSnapshot, activeLotIdxSnapshot ?? activeLotIdx);
        console.log(
          '[LotListing] Camera draft saved',
          lotsSnapshot.reduce((s, l) => s + l.files.length + l.extraFiles.length, 0),
          'images'
        );
      } catch (error) {
        console.error('Camera draft save error:', error);
        throw error;
      }
      return;
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveCurrentDraftNow();
        console.log('[LotListing] Auto-saved', lots.reduce((s, l) => s + l.files.length, 0), 'images');
      } catch (error) {
        console.error('Auto-save error:', error);
      }
    }, 2000);
  }, [activeLotIdx, lots, saveCurrentDraftNow]);

  // Trigger auto-save when form fields or lots change after a contract number exists.
  useEffect(() => {
    if (visible && contractNo.trim() && hasDraftableWork()) {
      triggerAutoSave();
    }
  }, [contractNo, hasDraftableWork, triggerAutoSave, visible]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  const toggleAuctionService = useCallback((lotIndex: number, serviceId: string) => {
    setAuctionServiceSelections((prev) => {
      const current = new Set(prev[lotIndex] || []);
      if (current.has(serviceId)) {
        current.delete(serviceId);
      } else {
        current.add(serviceId);
      }
      return { ...prev, [lotIndex]: Array.from(current) };
    });
  }, []);

  const serializeAuctionService = useCallback((service?: AuctionManagementServiceItem & { catalogName?: string }) => {
    if (!service) return null;
    return {
      revenueContractId: service.revenueContractId,
      revenueContractServiceId: service.rowGuid,
      serviceName: service.serviceName,
      price: Number(String(service.defaultPrice ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      gstPercent: Number(String(service.gstPercent ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      pstPercent: Number(String(service.pstPercent ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      quantity: 1,
    };
  }, []);

  const buildAuctionsoftMetadata = useCallback((destination: AuctionManagementDestination) => {
    if (!auctionManagementTask) return undefined;
    return {
      taskId: auctionManagementTask.task.rowGuid,
      contractId: auctionManagementTask.contract.rowGuid,
      contractNumber: auctionManagementTask.contract.contractNumber,
      destination,
      closeContract: auctionCloseContract,
      seedLots: auctionManagementTask.lots,
      selectedServicesByLot: lots.map((lot, index) => {
        const seedLot = auctionManagementTask.lots[index];
        return {
          lotIndex: index,
          lotId: lot.id,
          seedLotId: seedLot?.id,
          sourceLotId: seedLot?.sourceLotId,
          scheduleALotId: seedLot?.scheduleALotId,
          selectedServices: (auctionServiceSelections[index] || [])
            .map((serviceId) => serializeAuctionService(auctionServiceById.get(serviceId)))
            .filter(Boolean),
        };
      }),
    };
  }, [
    auctionCloseContract,
    auctionManagementTask,
    auctionServiceById,
    auctionServiceSelections,
    lots,
    serializeAuctionService,
  ]);

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!contractNo.trim()) e.contractNo = 'Required';
    const totalImages = lots.reduce((sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0), 0);
    if (totalImages === 0) e.images = 'Add at least one image';

    // Check that all lots have a mode set
    const lotsWithoutMode = lots.filter(lot => !lot.mode);
    if (lotsWithoutMode.length > 0) e.mode = 'All lots must have a mode selected';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // Create a new lot and return its index
  const handleCreateLot = useCallback(() => {
    if (!requireContractNumberForDraft()) return -1;
    const newLot = createNewLot();
    setLots((prev) => [...prev, newLot]);
    const newIdx = lots.length;
    if (isAuctionManagementMode) {
      setAuctionServiceSelections((prev) => ({ ...prev, [newIdx]: [] }));
    }
    setActiveLotIdx(newIdx);
    return newIdx;
  }, [isAuctionManagementMode, lots.length, requireContractNumberForDraft]);

  // Open camera for a specific lot
  const handleOpenCamera = useCallback((lotIdx: number) => {
    if (!requireContractNumberForDraft()) return;
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
  }, [requireContractNumberForDraft]);

  const handleCameraClose = useCallback(() => {
    setCameraOpen(false);
    clearError('images');
  }, []);

  const clearCurrentDraft = async () => {
    try {
      if (currentDraftId) {
        await AutoSaveService.deleteDraft(currentDraftId);
      } else {
        await AutoSaveService.deleteAutoSave();
      }
    } catch (error) {
      console.error('Error clearing draft:', error);
    }
  };

  const handleSubmit = async (
    destination: AuctionManagementDestination = 'LottingBoard',
    options: { forceNew?: boolean } = {}
  ) => {
    if (!validateForm()) {
      Alert.alert('Validation Error', 'Please fix the required fields');
      return;
    }

    setSubmitting(true);
    setUploadProgress(0);

    let details: LotListingDetails | null = null;
    let serviceLots: LotListingLot[] | null = null;

    try {
      if (options.forceNew) submissionIdRef.current = null;
      const jobId =
        submissionIdRef.current ||
        `ll-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      submissionIdRef.current = jobId;

      // Simple lot mapping for upload
      const mixedLots = lots.map((lot) => ({
        count: lot.files.length,
        extra_count: lot.extraFiles?.length || 0,
        cover_index: lot.coverIndex || 0,
        mode: lot.mode || 'single_lot',
      }));

      // Collect per-image focus box data (flat image index)
      const focusBoxes: Array<{ imageIndex: number; x: number; y: number; w: number; h: number }> = [];
      let flatImgIdx = 0;
      for (const lot of lots) {
        for (const f of lot.files) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
        for (const f of (lot.extraFiles || [])) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
      }

      details = {
        contract_no: contractNo.trim(),
        sales_date: salesDate,
        location: location.trim(),
        latitude,
        longitude,
        include_damage_analysis: true,
        bank_photos_enabled: bankPhotosEnabled,
        valuation_methods: LOT_LISTING_VALUATION_METHODS,
        mixed_lots: mixedLots,
        focus_boxes: focusBoxes.length > 0 ? focusBoxes : undefined,
        progress_id: jobId,
        client_submission_id: jobId,
        force_new: options.forceNew === true,
        auctionsoft: buildAuctionsoftMetadata(destination),
      };

      // Convert MixedLot to service format
      serviceLots = lots.map((lot, idx) => ({
        id: lot.id,
        files: lot.files.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        extraFiles: (lot.extraFiles || []).map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        lot_number: idx + 1,
        mode: lot.mode,
        coverIndex: lot.coverIndex,
      }));

      const connectivity = await OfflineQueueService.getConnectivityStatus();
      if (connectivity.status === 'offline') {
        const offlineDraft = await saveCurrentDraftNow();
        const offlineDraftId = offlineDraft?.id || currentDraftId || undefined;
        await OfflineQueueService.enqueueLotListing(details, serviceLots, {
          sourceDraftId: offlineDraftId,
        });

        if (offlineDraftId) {
          await AutoSaveService.removeDraftRecordOnly(offlineDraftId);
          setCurrentDraftId(null);
          loadedDraftIdRef.current = null;
        } else {
          await clearCurrentDraft();
        }

        setSubmitting(false);
        await resetForm({ clearDraft: false });
        onClose();
        Alert.alert(
          'Saved for Upload',
          'No internet connection was detected. Your lot listing is safely queued and will upload automatically when the connection returns. You can monitor it in Drafts.'
        );
        if (onSuccess) onSuccess();
        return;
      }

      await lotListingService.createLotListing(details, serviceLots, (progress) => {
        setUploadProgress(progress);
      });

      // Upload complete - close immediately, don't wait for server processing
      setSubmitting(false);
      await resetForm();
      await AutoSaveService.cleanupOrphanedMedia([], 0).catch(() => undefined);
      onClose();
      Alert.alert(
        'Upload Complete!',
        'Your images have been uploaded. You will receive an email when the files are ready.'
      );
      if (onSuccess) onSuccess();
    } catch (e: any) {
      console.error('Submit error:', e);

      if (e?.response?.status === 409 && e?.response?.data?.code === 'ACTIVE_REPORT_EXISTS') {
        setSubmitting(false);
        Alert.alert(
          'Report Already Processing',
          'A report for this contract is already queued or processing.',
          [
            {
              text: 'Resume Existing',
              onPress: () => {
                void handleClose();
                onSuccess?.();
              },
            },
            {
              text: 'Create Separate',
              onPress: () => void handleSubmit(destination, { forceNew: true }),
            },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
        return;
      }

      if (details && serviceLots && (await OfflineQueueService.shouldQueueAfterError(e))) {
        try {
          const offlineDraft = await saveCurrentDraftNow();
          const offlineDraftId = offlineDraft?.id || currentDraftId || undefined;
          await OfflineQueueService.enqueueLotListing(details, serviceLots, {
            sourceDraftId: offlineDraftId,
          });

          if (offlineDraftId) {
            await AutoSaveService.removeDraftRecordOnly(offlineDraftId);
            setCurrentDraftId(null);
            loadedDraftIdRef.current = null;
          } else {
            await clearCurrentDraft();
          }

          setSubmitting(false);
          await resetForm({ clearDraft: false });
          onClose();
          Alert.alert(
            'Saved for Upload',
            'The internet connection was lost during upload. Your lot listing is safely queued and will retry automatically when the connection returns.'
          );
          if (onSuccess) onSuccess();
          return;
        } catch (queueErr: any) {
          console.error('Queue error:', queueErr);
          setSubmitting(false);
          Alert.alert(
            'Could Not Save Offline Upload',
            queueErr?.message || 'The lot listing remains open. Check the selected photos, then try again.'
          );
          return;
        }
      }

      setSubmitting(false);
      const feedback = OfflineQueueService.getSubmissionError(e);
      Alert.alert(feedback.title, feedback.message);
    }
  };

  const resetForm = async (options: { clearDraft?: boolean } = {}) => {
    setContractNo('');
    setSalesDate(isoDate(new Date()));
    setLocation(normalizeHiddenLocation().location);
    setLatitude(undefined);
    setLongitude(undefined);
    setBankPhotosEnabled(false);
    setLots([]);
    setActiveLotIdx(0);
    setAuctionCloseContract(false);
    setAuctionServiceSelections({});
    setUploadProgress(0);
    setErrors({});
    if (options.clearDraft !== false) {
      await clearCurrentDraft();
    }
    setCurrentDraftId(null);
    loadedDraftIdRef.current = null;
    submissionIdRef.current = null;
  };

  const handleClose = async () => {
    if (submitting) return;
    if (hasDraftableWork() && !requireContractNumberForDraft()) return;
    try {
      if (draftSavePromiseRef.current) {
        await draftSavePromiseRef.current;
      }
      await saveCurrentDraftNow();
    } catch (error) {
      console.error('Error saving draft before close:', error);
    }
    setContractNo('');
    setSalesDate(isoDate(new Date()));
    setLocation(normalizeHiddenLocation().location);
    setLatitude(undefined);
    setLongitude(undefined);
    setBankPhotosEnabled(false);
    setLots([]);
    setActiveLotIdx(0);
    setAuctionCloseContract(false);
    setAuctionServiceSelections({});
    setUploadProgress(0);
    setErrors({});
    setCurrentDraftId(null);
    loadedDraftIdRef.current = null;
    onClose();
  };

  const totalImages = lots.reduce((sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0), 0);
  const canSubmit =
    contractNo.trim() &&
    totalImages > 0 &&
    lots.every(lot => lot.mode);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isAuctionManagementMode ? 'Auction Management' : 'Lot Listing'}</Text>
          <View style={styles.headerActions}>
            {isAuctionManagementMode ? (
              <View style={styles.headerSpacer} />
            ) : (
              <TouchableOpacity
                style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                onPress={() => handleSubmit()}
                disabled={!canSubmit || submitting}>
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Submit</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Progress Overlay */}
        {submitting && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <ActivityIndicator size="large" color="#8B5CF6" />
              <Text style={styles.progressText}>Uploading images...</Text>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
              </View>
              <Text style={styles.progressPercent}>{uploadProgress}%</Text>
            </View>
          </View>
        )}

        {/* Restore Draft Modal */}
        <Modal
          visible={showRestorePrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowRestorePrompt(false)}>
          <View style={styles.restoreModalOverlay}>
            <View style={styles.restoreModalContent}>
              <View style={styles.restoreModalIcon}>
                <Feather name="refresh-cw" size={32} color="#8B5CF6" />
              </View>
              <Text style={styles.restoreModalTitle}>Restore Draft?</Text>
              <Text style={styles.restoreModalText}>
                You have a saved draft with {autoSaveInfo?.totalImages || 0} images from{' '}
                {autoSaveInfo?.totalLots || 0} lot(s).
              </Text>
              {autoSaveInfo?.savedAt && (
                <Text style={styles.restoreModalTime}>
                  Saved {new Date(autoSaveInfo.savedAt).toLocaleString()}
                </Text>
              )}
              <View style={styles.restoreModalButtons}>
                <TouchableOpacity
                  style={styles.restoreModalDiscardBtn}
                  onPress={handleDiscardAutoSave}>
                  <Text style={styles.restoreModalDiscardText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.restoreModalRestoreBtn}
                  onPress={handleRestoreAutoSave}>
                  <Text style={styles.restoreModalRestoreText}>Restore</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Single scrollable content with details at top */}
        <ScrollView
          style={styles.scrollContent}
          contentContainerStyle={styles.scrollContentContainer}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {isAuctionManagementMode && auctionManagementTask ? (
            <View style={styles.auctionTaskBanner}>
              <View style={styles.auctionTaskHeader}>
                <View style={styles.auctionTaskIcon}>
                  <Feather name="briefcase" size={18} color="#1D4ED8" />
                </View>
                <View style={styles.auctionTaskTitleWrap}>
                  <Text style={styles.auctionTaskEyebrow}>Auctionsoft Contract</Text>
                  <Text style={styles.auctionTaskTitle} numberOfLines={1}>
                    Contract {auctionManagementTask.contract?.contractNumber || contractNo}
                  </Text>
                </View>
              </View>
              <View style={styles.auctionTaskMetaGrid}>
                <View style={styles.auctionTaskMeta}>
                  <Text style={styles.auctionTaskMetaLabel}>Customer</Text>
                  <Text style={styles.auctionTaskMetaValue} numberOfLines={1}>{auctionCustomerName}</Text>
                </View>
                <View style={styles.auctionTaskMeta}>
                  <Text style={styles.auctionTaskMetaLabel}>Location</Text>
                  <Text style={styles.auctionTaskMetaValue} numberOfLines={1}>{auctionLocationLabel}</Text>
                </View>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.seedLotTabs}>
                {lots.map((lot, index) => {
                  const active = index === activeLotIdx;
                  const seedLot = auctionManagementTask.lots[index];
                  return (
                    <TouchableOpacity
                      key={lot.id || index}
                      style={[styles.seedLotTab, active && styles.seedLotTabActive]}
                      onPress={() => setActiveLotIdx(index)}
                      activeOpacity={0.84}>
                      <Text style={[styles.seedLotTabText, active && styles.seedLotTabTextActive]}>
                        Lot {index + 1}
                      </Text>
                      {seedLot?.source ? (
                        <Text style={[styles.seedLotTabSubtext, active && styles.seedLotTabSubtextActive]} numberOfLines={1}>
                          {seedLot.source === 'scheduleA' || seedLot.source === 'schedule_a' ? 'Schedule A' : seedLot.source}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {/* Details Section - Collapsible */}
          <View style={styles.detailsSection}>
            <TouchableOpacity
              style={styles.sectionHeader}
              onPress={() => setDetailsExpanded(!detailsExpanded)}
              activeOpacity={0.7}>
              <Text style={styles.sectionTitle}>Listing Details</Text>
              <Feather
                name={detailsExpanded ? 'chevron-up' : 'chevron-down'}
                size={20}
                color="#6B7280"
              />
            </TouchableOpacity>

            {detailsExpanded && (
              <View style={styles.detailsContent}>
                <View style={styles.fieldContainerSmall}>
                  <Text style={styles.fieldLabelSmall}>Contract # *</Text>
                  <TextInput
                    style={[
                      styles.inputSmall,
                      errors.contractNo && styles.inputError,
                      isAuctionManagementMode && styles.inputLocked,
                    ]}
                    value={contractNo}
                    onChangeText={(t) => {
                      setContractNo(t);
                      clearError('contractNo');
                    }}
                    placeholder="Contract no."
                    placeholderTextColor="#9CA3AF"
                    keyboardType={isAuctionManagementMode ? 'default' : 'number-pad'}
                    editable={!isAuctionManagementMode}
                  />
                </View>
                <TouchableOpacity
                  style={styles.bankToggleRow}
                  activeOpacity={0.8}
                  onPress={() => setBankPhotosEnabled((prev) => !prev)}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.fieldLabelSmall}>Bank</Text>
                    <Text style={styles.bankToggleHelp}>Include all lot photos in the CR.</Text>
                  </View>
                  <View style={[styles.bankCheckbox, bankPhotosEnabled && styles.bankCheckboxActive]}>
                    {bankPhotosEnabled && <Feather name="check" size={14} color="#fff" />}
                  </View>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {isAuctionManagementMode && auctionManagementTask ? (
            <View style={styles.servicesSection}>
              <View style={styles.sectionHeaderStatic}>
                <Text style={styles.sectionTitle}>Service Revenue Contracts</Text>
                <Text style={styles.serviceCounter}>
                  Lot {activeLotIdx + 1} of {Math.max(lots.length, 1)}
                </Text>
              </View>
              <Text style={styles.seedLotText} numberOfLines={2}>
                {activeSeedLot?.description || `Lot ${activeLotIdx + 1}`}
              </Text>
              {auctionServices.length === 0 ? (
                <Text style={styles.emptyServicesText}>No revenue contracts configured.</Text>
              ) : (
                <View style={styles.serviceWrap}>
                  {auctionServices.map((service) => {
                    const selected = (auctionServiceSelections[activeLotIdx] || []).includes(service.rowGuid);
                    return (
                      <TouchableOpacity
                        key={service.rowGuid}
                        style={[styles.serviceChip, selected && styles.serviceChipActive]}
                        onPress={() => toggleAuctionService(activeLotIdx, service.rowGuid)}
                        activeOpacity={0.86}>
                        <Text style={[styles.serviceChipText, selected && styles.serviceChipTextActive]} numberOfLines={1}>
                          {service.serviceName}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          {/* Photos Section - Embedded LotManager */}
          <View style={styles.photosSection}>
            <LotManager
              lots={lots}
              setLots={setLots}
              activeLotIdx={activeLotIdx}
              setActiveLotIdx={setActiveLotIdx}
              onOpenCamera={handleOpenCamera}
              onCreateLot={handleCreateLot}
              hideSummary={true}
            />
          </View>
        </ScrollView>

        {isAuctionManagementMode && (
          <View style={styles.auctionActionBar}>
            <View style={styles.auctionSummaryRow}>
              <Text style={styles.auctionSummaryText}>{lots.length} lot{lots.length === 1 ? '' : 's'}</Text>
              <Text style={styles.auctionSummaryText}>{totalImages} image{totalImages === 1 ? '' : 's'}</Text>
            </View>
            <TouchableOpacity
              style={styles.closeContractRow}
              onPress={() => setAuctionCloseContract((prev) => !prev)}
              activeOpacity={0.85}>
              <View style={[styles.closeCheckbox, auctionCloseContract && styles.closeCheckboxActive]}>
                {auctionCloseContract && <Feather name="check" size={14} color="#fff" />}
              </View>
              <Text style={styles.closeContractText}>Contract Completed & Closed</Text>
            </TouchableOpacity>
            <View style={styles.destinationButtons}>
              <TouchableOpacity
                style={[styles.destinationButton, styles.lottingButton, !canSubmit && styles.destinationButtonDisabled]}
                onPress={() => handleSubmit('LottingBoard')}
                disabled={!canSubmit || submitting}
                activeOpacity={0.88}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="send" size={18} color="#fff" />}
                <Text style={styles.destinationButtonText}>Send to Lotting Board</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.destinationButton, styles.opTodoButton, !canSubmit && styles.destinationButtonDisabled]}
                onPress={() => handleSubmit('OpToDoBoard')}
                disabled={!canSubmit || submitting}
                activeOpacity={0.88}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="tool" size={18} color="#fff" />}
                <Text style={styles.destinationButtonText}>Send to Op To-Do</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Fixed Bottom Summary Bar */}
        {!isAuctionManagementMode && lots.length > 0 && (
          <View style={styles.fixedSummary}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{lots.length}</Text>
              <Text style={styles.summaryLabel}>Lots</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{totalImages}</Text>
              <Text style={styles.summaryLabel}>Images</Text>
            </View>
          </View>
        )}

        {/* Camera Modal */}
        {cameraOpen && (
          <CameraScreen
            visible={cameraOpen}
            onClose={handleCameraClose}
            lots={lots}
            setLots={setLots}
            activeLotIdx={activeLotIdx}
            setActiveLotIdx={setActiveLotIdx}
            onAutoSave={triggerAutoSave}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
    flex: 1,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerSpacer: {
    width: 80,
  },
  submitBtn: {
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    minWidth: 80,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    backgroundColor: '#D1D5DB',
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    width: '80%',
  },
  progressText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginTop: 16,
    marginBottom: 16,
  },
  progressBar: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8B5CF6',
    borderRadius: 4,
  },
  progressPercent: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 8,
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentContainer: {
    paddingBottom: 40,
  },
  auctionTaskBanner: {
    backgroundColor: '#FFFFFF',
    margin: 12,
    marginBottom: 0,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  auctionTaskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  auctionTaskIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    marginRight: 10,
  },
  auctionTaskTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  auctionTaskEyebrow: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  auctionTaskTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '900',
    marginTop: 2,
  },
  auctionTaskMetaGrid: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  auctionTaskMeta: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  auctionTaskMetaLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  auctionTaskMetaValue: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  seedLotTabs: {
    gap: 8,
    paddingTop: 12,
  },
  seedLotTab: {
    minWidth: 74,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  seedLotTabActive: {
    borderColor: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  seedLotTabText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '900',
  },
  seedLotTabTextActive: {
    color: '#1D4ED8',
  },
  seedLotTabSubtext: {
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 2,
  },
  seedLotTabSubtextActive: {
    color: '#2563EB',
  },
  detailsSection: {
    backgroundColor: '#fff',
    margin: 12,
    marginBottom: 0,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
  },
  detailsContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 0,
  },
  compactRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  compactField: {
    flex: 1,
  },
  fieldContainerSmall: {
    marginBottom: 10,
  },
  fieldLabelSmall: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 4,
  },
  bankToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    backgroundColor: '#F9FAFB',
  },
  bankToggleHelp: {
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 15,
  },
  bankCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#C4B5FD',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  bankCheckboxActive: {
    backgroundColor: '#8B5CF6',
    borderColor: '#8B5CF6',
  },
  inputSmall: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#1F2937',
  },
  inputLocked: {
    backgroundColor: '#F1F5F9',
    color: '#475569',
  },
  servicesSection: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeaderStatic: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  serviceCounter: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '700',
  },
  seedLotText: {
    marginTop: 6,
    color: '#475569',
    fontSize: 12,
    lineHeight: 17,
  },
  emptyServicesText: {
    marginTop: 10,
    color: '#94A3B8',
    fontSize: 12,
    fontStyle: 'italic',
  },
  serviceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  serviceChip: {
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
  },
  serviceChipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#DBEAFE',
  },
  serviceChipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
  },
  serviceChipTextActive: {
    color: '#1D4ED8',
  },
  datePickerSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  datePickerTextSmall: {
    fontSize: 13,
    color: '#1F2937',
    flex: 1,
  },
  photosSection: {
    flex: 1,
    minHeight: 300,
  },
  auctionActionBar: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  auctionSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  auctionSummaryText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '800',
  },
  closeContractRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  closeCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeCheckboxActive: {
    borderColor: '#16A34A',
    backgroundColor: '#16A34A',
  },
  closeContractText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
  },
  destinationButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  destinationButton: {
    flex: 1,
    minHeight: 72,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  lottingButton: {
    backgroundColor: '#16A34A',
  },
  opTodoButton: {
    backgroundColor: '#F97316',
  },
  destinationButtonDisabled: {
    opacity: 0.45,
  },
  destinationButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  // Fixed bottom summary
  fixedSummary: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 4,
  },
  summaryItem: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#2563EB',
  },
  summaryLabel: {
    fontSize: 10,
    color: '#6B7280',
    marginTop: 1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  summaryDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#E5E7EB',
  },
  fieldContainer: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#EF4444',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 12,
    marginTop: 4,
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  datePickerText: {
    fontSize: 15,
    color: '#1F2937',
    flex: 1,
  },
  datePickerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  datePickerModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20,
  },
  datePickerModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  datePickerModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
  },
  datePickerCancelText: {
    fontSize: 16,
    color: '#6B7280',
  },
  datePickerDoneText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8B5CF6',
  },
  iosDatePicker: {
    height: 200,
  },
  // Restore Modal Styles
  restoreModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  restoreModalContent: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  restoreModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#F3E8FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  restoreModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 8,
    textAlign: 'center',
  },
  restoreModalText: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  restoreModalTime: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 20,
  },
  restoreModalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  restoreModalDiscardBtn: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  restoreModalDiscardText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6B7280',
  },
  restoreModalRestoreBtn: {
    flex: 1,
    backgroundColor: '#8B5CF6',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  restoreModalRestoreText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
});

export default LotListingFormSheet;
