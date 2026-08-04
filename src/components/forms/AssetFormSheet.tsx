import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Dimensions,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Localization from 'expo-localization';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useAuth } from '../../context/AuthContext';
import CameraCapture, { CaptureMode, MixedLot } from './CameraCapture';
import LotManager from './LotManager';
import assetService, { AssetCreateDetails, MixedLot as ServiceMixedLot, ProgressData } from '../../services/assetService';
import AutoSaveService, { AutoSaveData, AutoSaveFormData } from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import { getPhotoUploadUri, normalizePhotoFile } from '../../utils/photoFileUtils';
import savedInputService from '../../services/savedInputService';
import {
  getHiddenCurrentLocation,
  normalizeHiddenLocation,
  type HiddenLocationSnapshot,
} from '../../utils/mobileLocation';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const MAX_ASSET_LOT_PHOTOS = 200;

// Currency codes by region/locale
const CURRENCY_MAP: Record<string, string> = {
  'en-CA': 'CAD',
  'en-US': 'USD',
  'en-GB': 'GBP',
  'en-AU': 'AUD',
  'fr-CA': 'CAD',
  'fr-FR': 'EUR',
  'es-ES': 'EUR',
  'es-MX': 'MXN',
  'de-DE': 'EUR',
  'it-IT': 'EUR',
  'pt-BR': 'BRL',
  'ja-JP': 'JPY',
  'zh-CN': 'CNY',
  'ko-KR': 'KRW',
  'in-IN': 'INR',
  'hi-IN': 'INR',
};

// Lot mode types
export type LotMode = 'single_lot' | 'per_item' | 'per_photo';

// MixedLot type is imported from CameraCapture

// Saved input data type
export interface SavedInputData {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: Record<string, any>;
}

interface AssetFormSheetProps {
  visible: boolean;
  onClose: () => void;
  savedInputData?: SavedInputData | null;
  draftIdToLoad?: string | null;
  onDraftLoaded?: () => void;
}

// Calendar-only fields must use the device calendar date, not UTC. Using
// toISOString() can move a selected date backward in western time zones.
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const AssetFormSheet = ({
  visible,
  onClose,
  savedInputData,
  draftIdToLoad,
  onDraftLoaded,
}: AssetFormSheetProps) => {
  const { user } = useAuth();

  // Form fields
  const [clientName, setClientName] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(isoDate(new Date()));
  const [appraisalPurpose, setAppraisalPurpose] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [appraiser, setAppraiser] = useState((user as any)?.username || '');
  const [appraisalCompany, setAppraisalCompany] = useState((user as any)?.companyName || '');
  const [industry, setIndustry] = useState('');
  const [inspectionDate, setInspectionDate] = useState(isoDate(new Date()));
  const [contractNo, setContractNo] = useState('');
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>('en');
  const [currency, setCurrency] = useState('');
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const [preparedFor, setPreparedFor] = useState('');
  const [factorsAgeCondition, setFactorsAgeCondition] = useState('');
  const [factorsQuality, setFactorsQuality] = useState('');
  const [factorsAnalysis, setFactorsAnalysis] = useState('');
  const [includeDamageAnalysis, setIncludeDamageAnalysis] = useState(true);
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(false);
  const [hiddenLocation, setHiddenLocation] = useState<HiddenLocationSnapshot | null>(null);

  // Valuation methods
  const [includeValuationTable, setIncludeValuationTable] = useState(false);
  const [selectedValuationMethods, setSelectedValuationMethods] = useState<
    Array<'FML' | 'TKV' | 'OLV' | 'FLV'>
  >(['FML']);

  // Lots state
  const [lots, setLots] = useState<MixedLot[]>([]);
  const [activeStep, setActiveStep] = useState<'details' | 'images'>('details');

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeLotIdx, setActiveLotIdx] = useState(-1);
  const [enhanceImages, setEnhanceImages] = useState(false); // Server-side enhancement toggle

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<
    'idle' | 'uploading' | 'processing' | 'done' | 'error'
  >('idle');
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

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
  const inspectionDateEditedRef = useRef(false);
  const savedInputHydrationRef = useRef<string | null>(null);

  // Date picker state
  const [showEffectiveDatePicker, setShowEffectiveDatePicker] = useState(false);
  const [showInspectionDatePicker, setShowInspectionDatePicker] = useState(false);

  // Parse date string to Date object
  const parseDate = (dateStr: string): Date => {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const parsed = year && month && day
      ? new Date(year, month - 1, day, 12, 0, 0)
      : new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  };

  // Format date for display
  const formatDateDisplay = (dateStr: string): string => {
    try {
      const date = parseDate(dateStr);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // Handle date change from picker
  const handleEffectiveDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowEffectiveDatePicker(false);
    }
    if (event.type === 'set' && selectedDate) {
      setEffectiveDate(isoDate(selectedDate));
      clearError('effectiveDate');
    }
  };

  const handleInspectionDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowInspectionDatePicker(false);
    }
    if (event.type === 'set' && selectedDate) {
      inspectionDateEditedRef.current = true;
      setInspectionDate(isoDate(selectedDate));
    }
  };

  // Keep legacy single autosave recoverable through the Offline Reports page.
  useEffect(() => {
    if (visible && !savedInputData && !draftIdToLoad) {
      void AutoSaveService.migrateLegacyAutoSaveIfNeeded();
    }
  }, [visible, savedInputData, draftIdToLoad]);

  const checkForAutoSave = async () => {
    try {
      const summary = await AutoSaveService.getAutoSaveSummary();
      if (summary.exists && summary.totalImages && summary.totalImages > 0) {
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
      if (data) {
        // Restore form data
        if (data.formData.clientName) setClientName(data.formData.clientName);
        if (data.formData.effectiveDate) setEffectiveDate(data.formData.effectiveDate);
        if (data.formData.appraisalPurpose) setAppraisalPurpose(data.formData.appraisalPurpose);
        if (data.formData.ownerName) setOwnerName(data.formData.ownerName);
        if (data.formData.appraiser) setAppraiser(data.formData.appraiser);
        if (data.formData.appraisalCompany) setAppraisalCompany(data.formData.appraisalCompany);
        if (data.formData.industry) setIndustry(data.formData.industry);
        if (data.formData.inspectionDate) setInspectionDate(data.formData.inspectionDate);
        if (data.formData.contractNo) setContractNo(data.formData.contractNo);
        if (
          data.formData.location ||
          data.formData.latitude !== undefined ||
          data.formData.longitude !== undefined
        ) {
          setHiddenLocation(
            normalizeHiddenLocation(
              data.formData.location,
              data.formData.latitude,
              data.formData.longitude
            )
          );
        }
        if (data.formData.language) setLanguage(data.formData.language);
        if (data.formData.currency) setCurrency(data.formData.currency);
        if (data.formData.preparedFor) setPreparedFor(data.formData.preparedFor);
        if (data.formData.factorsAgeCondition)
          setFactorsAgeCondition(data.formData.factorsAgeCondition);
        if (data.formData.factorsQuality) setFactorsQuality(data.formData.factorsQuality);
        if (data.formData.factorsAnalysis) setFactorsAnalysis(data.formData.factorsAnalysis);
        if (typeof data.formData.includeDamageAnalysis === 'boolean') {
          setIncludeDamageAnalysis(data.formData.includeDamageAnalysis);
        }
        if (typeof data.formData.bankPhotosEnabled === 'boolean') {
          setBankPhotosEnabled(data.formData.bankPhotosEnabled);
        }
        if (typeof data.formData.includeValuationTable === 'boolean')
          setIncludeValuationTable(data.formData.includeValuationTable);
        if (
          Array.isArray(data.formData.selectedValuationMethods) &&
          data.formData.selectedValuationMethods.length > 0
        ) {
          setSelectedValuationMethods(data.formData.selectedValuationMethods);
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
      if (data.formData.clientName) setClientName(data.formData.clientName);
      if (data.formData.clientSubmissionId) {
        submissionIdRef.current = data.formData.clientSubmissionId;
      }
      if (data.formData.effectiveDate) setEffectiveDate(data.formData.effectiveDate);
      if (data.formData.appraisalPurpose) setAppraisalPurpose(data.formData.appraisalPurpose);
      if (data.formData.ownerName) setOwnerName(data.formData.ownerName);
      if (data.formData.appraiser) setAppraiser(data.formData.appraiser);
      if (data.formData.appraisalCompany) setAppraisalCompany(data.formData.appraisalCompany);
      if (data.formData.industry) setIndustry(data.formData.industry);
      if (data.formData.inspectionDate) setInspectionDate(data.formData.inspectionDate);
      if (data.formData.contractNo) setContractNo(data.formData.contractNo);
      if (
        data.formData.location ||
        data.formData.latitude !== undefined ||
        data.formData.longitude !== undefined
      ) {
        setHiddenLocation(
          normalizeHiddenLocation(
            data.formData.location,
            data.formData.latitude,
            data.formData.longitude
          )
        );
      }
      if (data.formData.language) setLanguage(data.formData.language);
      if (data.formData.currency) setCurrency(data.formData.currency);
      if (data.formData.preparedFor) setPreparedFor(data.formData.preparedFor);
      if (data.formData.factorsAgeCondition)
        setFactorsAgeCondition(data.formData.factorsAgeCondition);
      if (data.formData.factorsQuality) setFactorsQuality(data.formData.factorsQuality);
      if (data.formData.factorsAnalysis) setFactorsAnalysis(data.formData.factorsAnalysis);
      if (typeof data.formData.includeDamageAnalysis === 'boolean') {
        setIncludeDamageAnalysis(data.formData.includeDamageAnalysis);
      }
      if (typeof data.formData.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.formData.bankPhotosEnabled);
      }
      if (typeof data.formData.includeValuationTable === 'boolean')
        setIncludeValuationTable(data.formData.includeValuationTable);
      if (
        Array.isArray(data.formData.selectedValuationMethods) &&
        data.formData.selectedValuationMethods.length > 0
      ) {
        setSelectedValuationMethods(data.formData.selectedValuationMethods);
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
        setActiveStep('images');
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
        if (cancelled || !draft || draft.type !== 'asset') return;
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
        (submissionIdRef.current = `cv-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
      clientName,
      effectiveDate,
      appraisalPurpose,
      ownerName,
      appraiser,
      appraisalCompany,
      industry,
      inspectionDate,
      contractNo,
      location: hiddenLocation?.location,
      latitude: hiddenLocation?.latitude,
      longitude: hiddenLocation?.longitude,
      language,
      currency,
      preparedFor,
      factorsAgeCondition,
      factorsQuality,
      factorsAnalysis,
      includeDamageAnalysis,
      bankPhotosEnabled,
      includeValuationTable,
      selectedValuationMethods,
    }),
    [
      clientName,
      effectiveDate,
      appraisalPurpose,
      ownerName,
      appraiser,
      appraisalCompany,
      industry,
      inspectionDate,
      contractNo,
      language,
      currency,
      preparedFor,
      factorsAgeCondition,
      factorsQuality,
      factorsAnalysis,
      includeDamageAnalysis,
      bankPhotosEnabled,
      includeValuationTable,
      selectedValuationMethods,
      hiddenLocation,
    ]
  );

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    void getHiddenCurrentLocation().then((snapshot) => {
      if (cancelled) return;
      setHiddenLocation((current) =>
        current?.latitude !== undefined && current?.longitude !== undefined ? current : snapshot
      );
    });

    return () => {
      cancelled = true;
    };
  }, [visible]);

  const hasDraftableWork = useCallback((candidateLots: MixedLot[] = lots) => {
    const hasImages = candidateLots.some((l) => l.files.length > 0 || l.extraFiles.length > 0 || l.videoFile);
    const hasLots = candidateLots.length > 0;
    const hasDetails = Boolean(
      clientName.trim() ||
        appraisalPurpose.trim() ||
        ownerName.trim() ||
        industry.trim() ||
        preparedFor.trim() ||
        factorsAgeCondition.trim() ||
        factorsQuality.trim() ||
        factorsAnalysis.trim()
    );
    return hasImages || hasLots || hasDetails;
  }, [
    appraisalPurpose,
    clientName,
    factorsAgeCondition,
    factorsAnalysis,
    factorsQuality,
    industry,
    lots,
    ownerName,
    preparedFor,
  ]);

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
      type: 'asset',
      title: clientName.trim() || contractNo.trim() || 'Asset Report',
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
  }, [
    activeLotIdx,
    buildAutoSaveFormData,
    clientName,
    contractNo,
    currentDraftId,
    hasDraftableWork,
    lots,
  ]);

  // Auto-save form data and images
  const triggerAutoSave = useCallback(async (
    lotsSnapshot?: MixedLot[],
    activeLotIdxSnapshot?: number
  ) => {
    // Clear any existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    if (lotsSnapshot) {
      try {
        await saveCurrentDraftNow(lotsSnapshot, activeLotIdxSnapshot ?? activeLotIdx);
        console.log(
          '[Asset] Camera draft saved',
          lotsSnapshot.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0),
          'images'
        );
      } catch (error) {
        console.error('Camera draft save error:', error);
        throw error;
      }
      return;
    }

    // Debounce auto-save (wait 2 seconds after last change)
    autoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveCurrentDraftNow();
      } catch (error) {
        console.error('Auto-save error:', error);
      }
    }, 2000);
  }, [activeLotIdx, saveCurrentDraftNow]);

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

  // State for saving inputs
  const [savingInputs, setSavingInputs] = useState(false);

  // Save inputs to server (like web version)
  const saveInputs = async () => {
    try {
      setSavingInputs(true);

      // Auto-generate name based on client name and date
      const baseName = clientName.trim() || 'Unnamed';
      const dateStr = new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const autoName = `${baseName} - ${dateStr}`;

      const formData = {
        clientName,
        effectiveDate,
        appraisalPurpose,
        ownerName,
        appraiser,
        appraisalCompany,
        industry,
        inspectionDate,
        contractNo,
        location: hiddenLocation?.location,
        latitude: hiddenLocation?.latitude,
        longitude: hiddenLocation?.longitude,
        language,
        currency,
        includeValuationTable,
        selectedValuationMethods,
        preparedFor,
        factorsAgeCondition,
        factorsQuality,
        factorsAnalysis,
        includeDamageAnalysis,
      };

      await savedInputService.create({
        name: autoName,
        formType: 'asset',
        formData,
      });

      Alert.alert('Success', 'Inputs saved successfully!');
    } catch (error: any) {
      console.error('Error saving inputs:', error);
      Alert.alert('Error', error?.response?.data?.message || 'Failed to save inputs');
    } finally {
      setSavingInputs(false);
    }
  };

  // Auto-detect currency on mount
  useEffect(() => {
    if (!currency && visible) {
      detectCurrency();
    }
  }, [visible]);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setAppraiser((user as any)?.username || '');
      setAppraisalCompany((user as any)?.companyName || '');
    }
  }, [user, visible]);

  // Load saved input data when provided
  useEffect(() => {
    if (savedInputData?.formData && visible) {
      const hydrationKey = `${savedInputData.name || 'saved'}:${JSON.stringify(savedInputData.formData).length}`;
      if (savedInputHydrationRef.current === hydrationKey) return;
      savedInputHydrationRef.current = hydrationKey;
      const data = savedInputData.formData;
      // Populate form fields from saved data
      if (data.clientName) setClientName(data.clientName);
      if (data.effectiveDate) setEffectiveDate(data.effectiveDate);
      if (data.appraisalPurpose) setAppraisalPurpose(data.appraisalPurpose);
      if (data.ownerName) setOwnerName(data.ownerName);
      if (data.appraiser) setAppraiser(data.appraiser);
      if (data.appraisalCompany) setAppraisalCompany(data.appraisalCompany);
      if (data.industry) setIndustry(data.industry);
      if (data.inspectionDate && !inspectionDateEditedRef.current) {
        setInspectionDate(data.inspectionDate);
      }
      if (data.contractNo) setContractNo(data.contractNo);
      if (data.language) setLanguage(data.language);
      if (data.currency) setCurrency(data.currency);
      if (data.preparedFor) setPreparedFor(data.preparedFor);
      if (data.factorsAgeCondition) setFactorsAgeCondition(data.factorsAgeCondition);
      if (data.factorsQuality) setFactorsQuality(data.factorsQuality);
      if (data.factorsAnalysis) setFactorsAnalysis(data.factorsAnalysis);
      if (typeof data.includeDamageAnalysis === 'boolean') {
        setIncludeDamageAnalysis(data.includeDamageAnalysis);
      }
      if (typeof data.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.bankPhotosEnabled);
      }
      if (typeof data.includeValuationTable === 'boolean')
        setIncludeValuationTable(data.includeValuationTable);
      if (
        Array.isArray(data.selectedValuationMethods) &&
        data.selectedValuationMethods.length > 0
      ) {
        setSelectedValuationMethods(data.selectedValuationMethods);
      }
    }
  }, [savedInputData, visible]);

  useEffect(() => {
    if (!visible) {
      inspectionDateEditedRef.current = false;
      savedInputHydrationRef.current = null;
    }
  }, [visible]);

  const detectCurrency = async () => {
    setCurrencyLoading(true);
    try {
      const locales = Localization.getLocales();
      const locale = locales[0];
      const localeTag = locale?.languageTag || 'en-US';

      // Try exact match first
      let detectedCurrency = CURRENCY_MAP[localeTag];

      // Try language-region match
      if (!detectedCurrency) {
        const langRegion = `${locale?.languageCode}-${locale?.regionCode}`;
        detectedCurrency = CURRENCY_MAP[langRegion];
      }

      // Try region-based detection
      if (!detectedCurrency && locale?.regionCode) {
        const regionMap: Record<string, string> = {
          US: 'USD',
          CA: 'CAD',
          GB: 'GBP',
          AU: 'AUD',
          NZ: 'NZD',
          EU: 'EUR',
          DE: 'EUR',
          FR: 'EUR',
          IT: 'EUR',
          ES: 'EUR',
          MX: 'MXN',
          BR: 'BRL',
          JP: 'JPY',
          CN: 'CNY',
          KR: 'KRW',
          IN: 'INR',
          RU: 'RUB',
          CH: 'CHF',
          SE: 'SEK',
          NO: 'NOK',
        };
        detectedCurrency = regionMap[locale.regionCode];
      }

      setCurrency(detectedCurrency || 'USD');
    } catch (e) {
      console.warn('Currency detection failed:', e);
      setCurrency('USD');
    } finally {
      setCurrencyLoading(false);
    }
  };

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!clientName.trim()) e.clientName = 'Required';
    if (!effectiveDate) e.effectiveDate = 'Required';
    if (!appraisalPurpose.trim()) e.appraisalPurpose = 'Required';
    if (!appraiser.trim()) e.appraiser = 'Required';
    if (!currency || !/^[A-Z]{3}$/.test(currency)) e.currency = 'Use 3-letter code';
    if (lots.length === 0) e.lots = 'Add at least one lot with images';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const clearError = (key: string) => {
    setErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const clearCurrentDraft = async () => {
    try {
      if (currentDraftId) {
        await AutoSaveService.deleteDraft(currentDraftId);
      } else {
        await AutoSaveService.deleteAutoSave();
      }
    } catch (e) {
      console.warn('Failed to clear draft:', e);
    }
  };

  const handleSubmit = async (options: { forceNew?: boolean } = {}) => {
    if (!validateForm()) {
      Alert.alert('Validation Error', 'Please fix the required fields');
      return;
    }

    // Check if there are any images
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0
    );
    if (totalImages === 0) {
      Alert.alert('No Images', 'Please add at least one image to submit');
      return;
    }
    const overLimitLotIndex = lots.findIndex(
      (lot) => lot.files.length + lot.extraFiles.length > MAX_ASSET_LOT_PHOTOS
    );
    if (overLimitLotIndex >= 0) {
      const lot = lots[overLimitLotIndex];
      Alert.alert(
        'Too Many Photos',
        `Lot ${overLimitLotIndex + 1} has ${lot.files.length + lot.extraFiles.length} photos. The maximum is ${MAX_ASSET_LOT_PHOTOS} photos per lot, including report-only photos.`
      );
      return;
    }

    setSubmitting(true);
    setProgressPhase('uploading');
    setUploadProgress(0);

    let details: AssetCreateDetails | null = null;
    let serviceLots: ServiceMixedLot[] | null = null;

    try {
      // Generate unique job ID for progress tracking
      if (options.forceNew) submissionIdRef.current = null;
      const newJobId =
        submissionIdRef.current ||
        `cv-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      submissionIdRef.current = newJobId;
      setJobId(newJobId);
      const locationSnapshot = hiddenLocation || normalizeHiddenLocation();

      // Build mixed_lots mapping for server
      const mixedLotsMapping = lots.map((lot) => ({
        count: lot.files.length,
        extra_count: lot.extraFiles.length,
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
        for (const f of lot.extraFiles) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
      }

      // Build details object matching web/server format
      details = {
        // Client info
        client_name: clientName.trim(),
        owner_name: ownerName.trim() || undefined,
        prepared_for: preparedFor.trim() || undefined,

        // Appraisal details
        appraisal_purpose: appraisalPurpose.trim(),
        effective_date: effectiveDate,
        inspection_date: inspectionDate || undefined,
        industry: industry.trim() || undefined,
        contract_no: contractNo.trim() || undefined,
        location: locationSnapshot.location,
        latitude: locationSnapshot.latitude,
        longitude: locationSnapshot.longitude,

        // Appraiser info
        appraiser: appraiser.trim(),
        appraisal_company: appraisalCompany.trim() || undefined,

        // Settings
        currency: currency.toUpperCase(),
        language: language,
        grouping_mode: 'mixed',

        // Valuation
        include_valuation_table: includeValuationTable,
        valuation_methods: includeValuationTable ? selectedValuationMethods : undefined,
        include_damage_analysis: includeDamageAnalysis,
        bank_photos_enabled: bankPhotosEnabled,

        // Factors
        factors_age_condition: factorsAgeCondition.trim() || undefined,
        factors_quality: factorsQuality.trim() || undefined,
        factors_analysis: factorsAnalysis.trim() || undefined,

        // Mixed lots mapping
        mixed_lots: mixedLotsMapping,

        // Image enhancement (server-side: +40% saturation, +40% sharpness, +30% contrast)
        enhance_images: enhanceImages,

        // Focus box data for AI (red rectangle drawn server-side)
        focus_boxes: focusBoxes.length > 0 ? focusBoxes : undefined,

        // Progress tracking
        progress_id: newJobId,
        client_submission_id: newJobId,
        force_new: options.forceNew === true,
      };

      // Convert MixedLot to service format
      serviceLots = lots.map((lot) => ({
        id: lot.id,
        files: lot.files.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type || 'image/jpeg',
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        extraFiles: lot.extraFiles.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type || 'image/jpeg',
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        videoFile: lot.videoFile
          ? {
              uri: lot.videoFile.uri,
              name: lot.videoFile.name,
              type: lot.videoFile.type || 'video/mp4',
            }
          : undefined,
        coverIndex: lot.coverIndex || 0,
        mode: lot.mode,
      }));

      const connectivity = await OfflineQueueService.getConnectivityStatus();
      if (connectivity.status === 'offline') {
        setProgressPhase('processing');
        const offlineDraft = await saveCurrentDraftNow();
        const offlineDraftId = offlineDraft?.id || currentDraftId || undefined;
        await OfflineQueueService.enqueueAssetReport(details, serviceLots, {
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
        resetForm();
        onClose();
        Alert.alert(
          'Saved for Upload',
          'No internet connection was detected. Your report is safely queued and will upload automatically when the connection returns. You can monitor it in Drafts.'
        );
        return;
      }

      // Submit to API
      await assetService.createAssetReport(details, serviceLots, (progress) => {
        setUploadProgress(progress);
      });

      // Upload complete - show success immediately
      setProgressPhase('done');

      // Clear auto-save data on success
      await clearCurrentDraft();
      await AutoSaveService.cleanupOrphanedMedia([], 0).catch(() => undefined);

      // Brief delay to show "Upload Complete" then close
      setTimeout(() => {
        setSubmitting(false);
        resetForm();
        onClose();
        Alert.alert(
          'Upload Complete! 🎉',
          'Your report has been uploaded successfully. Processing will continue in the background and you will receive an email when ready.'
        );
      }, 800);
    } catch (e: any) {
      console.error('Submit error:', e);

      if (e?.response?.status === 409 && e?.response?.data?.code === 'ACTIVE_REPORT_EXISTS') {
        setProgressPhase('error');
        setSubmitting(false);
        Alert.alert(
          'Report Already Processing',
          'An asset report for this contract is already queued or processing.',
          [
            {
              text: 'Resume Existing',
              onPress: () => void handleClose(),
            },
            {
              text: 'Create Separate',
              onPress: () => void handleSubmit({ forceNew: true }),
            },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
        return;
      }

      if (details && serviceLots && (await OfflineQueueService.shouldQueueAfterError(e))) {
        try {
          setProgressPhase('processing');
          const offlineDraft = await saveCurrentDraftNow();
          const offlineDraftId = offlineDraft?.id || currentDraftId || undefined;
          await OfflineQueueService.enqueueAssetReport(details, serviceLots, {
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
          resetForm();
          onClose();
          Alert.alert(
            'Saved for Upload',
            'The internet connection was lost during upload. Your report is safely queued and will retry automatically when the connection returns.'
          );
          return;
        } catch (queueErr: any) {
          console.error('Queue error:', queueErr);
          setProgressPhase('error');
          setSubmitting(false);
          Alert.alert(
            'Could Not Save Offline Upload',
            queueErr?.message || 'The report remains open. Check the selected photos, then try again.'
          );
          return;
        }
      }

      setProgressPhase('error');
      setSubmitting(false);
      const feedback = OfflineQueueService.getSubmissionError(e);
      Alert.alert(feedback.title, feedback.message);
    }
  };

  const resetForm = () => {
    submissionIdRef.current = null;
    setClientName('');
    setEffectiveDate(isoDate(new Date()));
    setAppraisalPurpose('');
    setOwnerName('');
    setAppraiser((user as any)?.username || '');
    setAppraisalCompany((user as any)?.companyName || '');
    setIndustry('');
    setInspectionDate(isoDate(new Date()));
    setContractNo('');
    setLanguage('en');
    setCurrency('');
    setPreparedFor('');
    setFactorsAgeCondition('');
    setFactorsQuality('');
    setFactorsAnalysis('');
    setIncludeDamageAnalysis(true);
    setBankPhotosEnabled(false);
    setHiddenLocation(null);
    setIncludeValuationTable(false);
    setSelectedValuationMethods(['FML']);
    setLots([]);
    setActiveStep('details');
    setProgressPhase('idle');
    setUploadProgress(0);
    setProgressData(null);
    setJobId(null);
    setErrors({});
    setCurrentDraftId(null);
    loadedDraftIdRef.current = null;
    // Re-detect currency
    detectCurrency();
  };

  const createLot = () => {
    if (!requireContractNumberForDraft()) return -1;
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newLot: MixedLot = {
      id,
      files: [],
      extraFiles: [],
      coverIndex: 0,
    };
    setLots((prev) => [...prev, newLot]);
    setActiveLotIdx(lots.length);
    return lots.length;
  };

  const openCameraForLot = (lotIdx: number) => {
    if (!requireContractNumberForDraft()) return;
    // Camera will auto-create lot if none exist
    // Just set the active index (can be -1 or 0, camera handles it)
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
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
    resetForm();
    onClose();
  };

  const toggleValuationMethod = (method: 'FML' | 'TKV' | 'OLV' | 'FLV') => {
    setSelectedValuationMethods((prev) => {
      if (prev.includes(method)) {
        if (prev.length === 1) {
          Alert.alert('Warning', 'At least one valuation method must be selected');
          return prev;
        }
        return prev.filter((m) => m !== method);
      }
      return [...prev, method];
    });
  };

  const renderDetailsStep = () => (
    <ScrollView
      style={styles.formScroll}
      contentContainerStyle={styles.formContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}>
      {/* Client Information Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Client Information</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Client Name *</Text>
          <TextInput
            style={[styles.input, errors.clientName && styles.inputError]}
            value={clientName}
            onChangeText={(t) => {
              setClientName(t);
              clearError('clientName');
            }}
            placeholder="Enter client name"
            placeholderTextColor="#9CA3AF"
          />
          {errors.clientName && <Text style={styles.errorText}>{errors.clientName}</Text>}
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Owner Name</Text>
          <TextInput
            style={styles.input}
            value={ownerName}
            onChangeText={setOwnerName}
            placeholder="Enter owner name"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Prepared For</Text>
          <TextInput
            style={styles.input}
            value={preparedFor}
            onChangeText={setPreparedFor}
            placeholder="Enter prepared for"
            placeholderTextColor="#9CA3AF"
          />
        </View>
      </View>

      {/* Appraisal Details Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appraisal Details</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Purpose of Appraisal *</Text>
          <TextInput
            style={[styles.input, errors.appraisalPurpose && styles.inputError]}
            value={appraisalPurpose}
            onChangeText={(t) => {
              setAppraisalPurpose(t);
              clearError('appraisalPurpose');
            }}
            placeholder="e.g., Insurance, Sale, Donation"
            placeholderTextColor="#9CA3AF"
          />
          {errors.appraisalPurpose && (
            <Text style={styles.errorText}>{errors.appraisalPurpose}</Text>
          )}
        </View>

        <View style={styles.row}>
          <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
            <Text style={styles.fieldLabel}>Effective Date *</Text>
            <TouchableOpacity
              style={[styles.datePickerButton, errors.effectiveDate && styles.inputError]}
              onPress={() => setShowEffectiveDatePicker(true)}>
              <Feather name="calendar" size={18} color="#6B7280" />
              <Text style={styles.datePickerText}>{formatDateDisplay(effectiveDate)}</Text>
            </TouchableOpacity>
            {showEffectiveDatePicker &&
              (Platform.OS === 'ios' ? (
                <Modal
                  transparent
                  animationType="slide"
                  visible={showEffectiveDatePicker}
                  onRequestClose={() => setShowEffectiveDatePicker(false)}>
                  <View style={styles.datePickerModalOverlay}>
                    <View style={styles.datePickerModalContent}>
                      <View style={styles.datePickerModalHeader}>
                        <TouchableOpacity onPress={() => setShowEffectiveDatePicker(false)}>
                          <Text style={styles.datePickerCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={styles.datePickerModalTitle}>Effective Date</Text>
                        <TouchableOpacity onPress={() => setShowEffectiveDatePicker(false)}>
                          <Text style={styles.datePickerDoneText}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        value={parseDate(effectiveDate)}
                        mode="date"
                        display="spinner"
                        onChange={handleEffectiveDateChange}
                        style={styles.iosDatePicker}
                      />
                    </View>
                  </View>
                </Modal>
              ) : (
                <DateTimePicker
                  value={parseDate(effectiveDate)}
                  mode="date"
                  display="default"
                  onChange={handleEffectiveDateChange}
                />
              ))}
          </View>
          <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
            <Text style={styles.fieldLabel}>Inspection Date</Text>
            <TouchableOpacity
              style={styles.datePickerButton}
              onPress={() => setShowInspectionDatePicker(true)}>
              <Feather name="calendar" size={18} color="#6B7280" />
              <Text style={styles.datePickerText}>{formatDateDisplay(inspectionDate)}</Text>
            </TouchableOpacity>
            {showInspectionDatePicker &&
              (Platform.OS === 'ios' ? (
                <Modal
                  transparent
                  animationType="slide"
                  visible={showInspectionDatePicker}
                  onRequestClose={() => setShowInspectionDatePicker(false)}>
                  <View style={styles.datePickerModalOverlay}>
                    <View style={styles.datePickerModalContent}>
                      <View style={styles.datePickerModalHeader}>
                        <TouchableOpacity onPress={() => setShowInspectionDatePicker(false)}>
                          <Text style={styles.datePickerCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={styles.datePickerModalTitle}>Inspection Date</Text>
                        <TouchableOpacity onPress={() => setShowInspectionDatePicker(false)}>
                          <Text style={styles.datePickerDoneText}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        value={parseDate(inspectionDate)}
                        mode="date"
                        display="spinner"
                        onChange={handleInspectionDateChange}
                        style={styles.iosDatePicker}
                      />
                    </View>
                  </View>
                </Modal>
              ) : (
                <DateTimePicker
                  value={parseDate(inspectionDate)}
                  mode="date"
                  display="default"
                  onChange={handleInspectionDateChange}
                />
              ))}
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Industry</Text>
          <TextInput
            style={styles.input}
            value={industry}
            onChangeText={setIndustry}
            placeholder="e.g., Manufacturing, Retail"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Contract No.</Text>
          <TextInput
            style={styles.input}
            value={contractNo}
            onChangeText={setContractNo}
            placeholder="Enter contract number"
            placeholderTextColor="#9CA3AF"
            keyboardType="number-pad"
          />
        </View>
      </View>

      {/* Appraiser Information Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appraiser Information</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Appraiser Name *</Text>
          <TextInput
            style={[styles.input, errors.appraiser && styles.inputError]}
            value={appraiser}
            onChangeText={(t) => {
              setAppraiser(t);
              clearError('appraiser');
            }}
            placeholder="Enter appraiser name"
            placeholderTextColor="#9CA3AF"
          />
          {errors.appraiser && <Text style={styles.errorText}>{errors.appraiser}</Text>}
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Appraisal Company</Text>
          <TextInput
            style={styles.input}
            value={appraisalCompany}
            onChangeText={setAppraisalCompany}
            placeholder="Enter company name"
            placeholderTextColor="#9CA3AF"
          />
        </View>
      </View>

      {/* Settings Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Settings</Text>

        <View style={styles.row}>
          <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
            <Text style={styles.fieldLabel}>Currency *</Text>
            <View style={styles.currencyContainer}>
              <TextInput
                style={[styles.input, styles.currencyInput, errors.currency && styles.inputError]}
                value={currency}
                onChangeText={(t) => {
                  setCurrency(t.toUpperCase());
                  clearError('currency');
                }}
                placeholder="CAD"
                placeholderTextColor="#9CA3AF"
                maxLength={3}
                autoCapitalize="characters"
              />
              {currencyLoading && (
                <ActivityIndicator size="small" color="#2563EB" style={styles.currencyLoader} />
              )}
            </View>
            {errors.currency && <Text style={styles.errorText}>{errors.currency}</Text>}
          </View>
          <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
            <Text style={styles.fieldLabel}>Language</Text>
            <View style={styles.languageRow}>
              {(['en', 'fr', 'es'] as const).map((lang) => (
                <TouchableOpacity
                  key={lang}
                  style={[styles.langButton, language === lang && styles.langButtonActive]}
                  onPress={() => setLanguage(lang)}>
                  <Text style={[styles.langText, language === lang && styles.langTextActive]}>
                    {lang.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </View>

      {/* Valuation Methods Section */}
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.toggleRow}
          onPress={() => setIncludeValuationTable(!includeValuationTable)}>
          <Text style={styles.sectionTitle}>Include Valuation Table</Text>
          <View style={[styles.checkbox, includeValuationTable && styles.checkboxActive]}>
            {includeValuationTable && <Feather name="check" size={14} color="#fff" />}
          </View>
        </TouchableOpacity>

        {includeValuationTable && (
          <View style={styles.methodsGrid}>
            {(['FML', 'TKV', 'OLV', 'FLV'] as const).map((method) => (
              <TouchableOpacity
                key={method}
                style={[
                  styles.methodButton,
                  selectedValuationMethods.includes(method) && styles.methodButtonActive,
                ]}
                onPress={() => toggleValuationMethod(method)}>
                <Text
                  style={[
                    styles.methodText,
                    selectedValuationMethods.includes(method) && styles.methodTextActive,
                  ]}>
                  {method}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Factors Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assessment Factors (Optional)</Text>

        <View style={styles.fieldContainer}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.fieldLabel}>Damages</Text>
              <Text style={{ fontSize: 12, color: '#6B7280' }}>
                Applies only to lots 1000 and below. Higher lot numbers are excluded automatically.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setIncludeDamageAnalysis((prev) => !prev)}
              style={[
                styles.checkbox,
                includeDamageAnalysis && styles.checkboxActive,
              ]}>
              {includeDamageAnalysis && <Feather name="check" size={14} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.fieldLabel}>Bank</Text>
              <Text style={{ fontSize: 12, color: '#6B7280' }}>
                Include all lot photos in the CR.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setBankPhotosEnabled((prev) => !prev)}
              style={[
                styles.checkbox,
                bankPhotosEnabled && styles.checkboxActive,
              ]}>
              {bankPhotosEnabled && <Feather name="check" size={14} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Age & Condition</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={factorsAgeCondition}
            onChangeText={setFactorsAgeCondition}
            placeholder="Describe age and condition factors..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Quality</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={factorsQuality}
            onChangeText={setFactorsQuality}
            placeholder="Describe quality factors..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Analysis</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={factorsAnalysis}
            onChangeText={setFactorsAnalysis}
            placeholder="Additional analysis notes..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtonsRow}>
        {/* Save Inputs Button */}
        <TouchableOpacity
          style={styles.saveInputsButton}
          onPress={saveInputs}
          disabled={savingInputs}>
          {savingInputs ? (
            <ActivityIndicator color="#059669" size="small" />
          ) : (
            <>
              <Feather name="save" size={18} color="#059669" />
              <Text style={styles.saveInputsButtonText}>Save Inputs</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Next Button */}
        <TouchableOpacity style={styles.nextButton} onPress={() => setActiveStep('images')}>
          <Text style={styles.nextButtonText}>Next: Add Images</Text>
          <Feather name="arrow-right" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Submit Button - Also available on details page */}
      <TouchableOpacity
        style={[
          styles.submitButtonDetails,
          (submitting || lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0) === 0) && styles.submitButtonDisabled,
        ]}
        onPress={() => void handleSubmit()}
        disabled={submitting || lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0) === 0}>
        {submitting ? (
          <>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={[styles.submitButtonText, { marginLeft: 8 }]}>
              {progressPhase === 'uploading' ? `${uploadProgress}%` : 'Processing...'}
            </Text>
          </>
        ) : (
          <>
            <Feather name="send" size={18} color="#fff" />
            <Text style={styles.submitButtonText}>Submit Report</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
  );

  const renderImagesStep = () => {
    // Calculate totals for display
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0
    );
    const totalLots = lots.filter(
      (lot) => lot.files.length > 0 || lot.extraFiles.length > 0
    ).length;

    return (
      <View style={styles.imagesContainer}>
        {/* Progress Overlay when submitting */}
        {submitting && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              {/* Header with icon */}
              <View style={styles.progressHeader}>
                {progressPhase === 'done' ? (
                  <View style={[styles.progressIconBg, { backgroundColor: '#D1FAE5' }]}>
                    <Feather name="check" size={28} color="#059669" />
                  </View>
                ) : (
                  <View style={styles.progressIconBg}>
                    <ActivityIndicator size="large" color="#2563EB" />
                  </View>
                )}
                <Text style={styles.progressTitle}>
                  {progressPhase === 'uploading'
                    ? 'Uploading Images...'
                    : progressPhase === 'done'
                      ? 'Complete!'
                      : 'Processing Report...'}
                </Text>
              </View>

              {/* Stats summary */}
              <View style={styles.progressStats}>
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalImages}</Text>
                  <Text style={styles.progressStatLabel}>Images</Text>
                </View>
                <View style={styles.progressStatDivider} />
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalLots}</Text>
                  <Text style={styles.progressStatLabel}>Lots</Text>
                </View>
              </View>

              {/* Progress Bar */}
              <View style={styles.progressBarContainer}>
                <View
                  style={[
                    styles.progressBar,
                    {
                      width: `${
                        progressPhase === 'uploading'
                          ? uploadProgress
                          : progressPhase === 'done'
                            ? 100
                            : (progressData?.serverProgress01 || 0) * 100
                      }%`,
                      backgroundColor: progressPhase === 'done' ? '#059669' : '#2563EB',
                    },
                  ]}
                />
              </View>

              <Text style={styles.progressText}>
                {progressPhase === 'uploading'
                  ? `${uploadProgress}% uploaded`
                  : progressPhase === 'done'
                    ? 'Report submitted successfully!'
                    : progressData?.message || 'Please wait...'}
              </Text>

              {/* Step indicators */}
              {progressData?.steps && progressData.steps.length > 0 && (
                <View style={styles.stepsContainer}>
                  {progressData.steps.slice(-4).map((step, idx) => (
                    <View key={step.key || idx} style={styles.stepRow}>
                      <Feather
                        name={step.endedAt ? 'check-circle' : 'loader'}
                        size={14}
                        color={step.endedAt ? '#059669' : '#2563EB'}
                      />
                      <Text style={[styles.stepText, step.endedAt && styles.stepTextDone]}>
                        {step.label}
                      </Text>
                      {step.durationMs && (
                        <Text style={styles.stepDuration}>
                          {(step.durationMs / 1000).toFixed(1)}s
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              {/* Processing info */}
              {progressPhase === 'processing' && !progressData?.steps?.length && (
                <Text style={styles.progressHint}>Software is analyzing your images...</Text>
              )}
            </View>
          </View>
        )}

        <LotManager
          lots={lots}
          setLots={setLots}
          activeLotIdx={activeLotIdx}
          setActiveLotIdx={setActiveLotIdx}
          onOpenCamera={openCameraForLot}
          onCreateLot={createLot}
        />

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.backButton, submitting && styles.buttonDisabled]}
            onPress={() => setActiveStep('details')}
            disabled={submitting}>
            <Feather name="arrow-left" size={20} color="#374151" />
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.submitButton,
              (submitting || totalImages === 0) && styles.submitButtonDisabled,
            ]}
            onPress={() => void handleSubmit()}
            disabled={submitting || totalImages === 0}>
            {submitting ? (
              <>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={[styles.submitButtonText, { marginLeft: 8 }]}>
                  {progressPhase === 'uploading' ? `${uploadProgress}%` : 'Processing...'}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.submitButtonText}>Submit Report</Text>
                <Feather name="send" size={18} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Asset Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.stepIndicator}>
              <View style={[styles.stepDot, activeStep === 'details' && styles.stepDotActive]} />
              <View style={styles.stepLine} />
              <View style={[styles.stepDot, activeStep === 'images' && styles.stepDotActive]} />
            </View>
          </View>
        </View>

        {/* 3D Tab Navigation */}
        <View style={styles.tabContainer}>
          <View style={styles.tabBackground}>
            <View
              style={[
                styles.tabSlider,
                {
                  left: activeStep === 'details' ? 4 : '50%',
                },
              ]}
            />
          </View>
          <TouchableOpacity
            style={[styles.tabButton, activeStep === 'details' && styles.tabButtonActive]}
            onPress={() => setActiveStep('details')}
            activeOpacity={0.7}>
            <View style={styles.tabIconContainer}>
              <Feather
                name="file-text"
                size={20}
                color={activeStep === 'details' ? '#FFFFFF' : '#6B7280'}
              />
            </View>
            <Text style={[styles.tabText, activeStep === 'details' && styles.tabTextActive]}>
              Details
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeStep === 'images' && styles.tabButtonActive]}
            onPress={() => setActiveStep('images')}
            activeOpacity={0.7}>
            <View style={styles.tabIconContainer}>
              <Feather
                name="image"
                size={20}
                color={activeStep === 'images' ? '#FFFFFF' : '#6B7280'}
              />
            </View>
            <Text style={[styles.tabText, activeStep === 'images' && styles.tabTextActive]}>
              Images
            </Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.content}>
          {activeStep === 'details' ? renderDetailsStep() : renderImagesStep()}
        </KeyboardAvoidingView>

        {/* Camera Modal */}
        <CameraCapture
            visible={cameraOpen}
            onClose={() => setCameraOpen(false)}
            lots={lots}
            setLots={setLots}
            activeLotIdx={activeLotIdx}
            setActiveLotIdx={setActiveLotIdx}
            onAutoSave={triggerAutoSave}
            enhanceImages={enhanceImages}
            onEnhanceChange={setEnhanceImages}
          />

        {/* Restore Auto-Save Prompt Modal */}
        <Modal
          visible={showRestorePrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowRestorePrompt(false)}>
          <View style={styles.restoreModalOverlay}>
            <View style={styles.restoreModalContent}>
              <View style={styles.restoreModalIcon}>
                <Feather name="refresh-cw" size={32} color="#2563EB" />
              </View>
              <Text style={styles.restoreModalTitle}>Restore Previous Session?</Text>
              <Text style={styles.restoreModalText}>
                Found {autoSaveInfo?.totalImages || 0} images from {autoSaveInfo?.totalLots || 0}{' '}
                lot(s)
                {autoSaveInfo?.savedAt &&
                  `\nSaved: ${new Date(autoSaveInfo.savedAt).toLocaleString()}`}
              </Text>
              <View style={styles.restoreModalButtons}>
                <TouchableOpacity
                  style={styles.restoreModalBtnDiscard}
                  onPress={handleDiscardAutoSave}>
                  <Feather name="trash-2" size={16} color="#EF4444" />
                  <Text style={styles.restoreModalBtnDiscardText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.restoreModalBtnRestore}
                  onPress={handleRestoreAutoSave}>
                  <Feather name="download" size={16} color="#fff" />
                  <Text style={styles.restoreModalBtnRestoreText}>Restore</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  closeButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    flex: 1,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#D1D5DB',
  },
  stepDotActive: {
    backgroundColor: '#2563EB',
  },
  stepLine: {
    width: 24,
    height: 2,
    backgroundColor: '#D1D5DB',
    marginHorizontal: 4,
  },
  // 3D Tab Navigation Styles
  tabContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    marginHorizontal: 16,
    marginVertical: 12,
    borderRadius: 16,
    padding: 4,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  tabBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  tabSlider: {
    position: 'absolute',
    width: '48%',
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 12,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 1,
  },
  tabButtonActive: {
    // Active state handled by slider background
  },
  tabIconContainer: {
    // Icon container for better alignment
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
  },
  formScroll: {
    flex: 1,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.04)',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1F2937',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  fieldContainer: {
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#DC2626',
  },
  // Date picker styles
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  datePickerText: {
    flex: 1,
    fontSize: 15,
    color: '#1F2937',
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
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    color: '#2563EB',
  },
  iosDatePicker: {
    height: 200,
  },
  errorText: {
    fontSize: 12,
    color: '#DC2626',
    marginTop: 4,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
  },
  currencyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currencyInput: {
    flex: 1,
  },
  currencyLoader: {
    marginLeft: -32,
    marginRight: 8,
  },
  languageRow: {
    flexDirection: 'row',
  },
  langButton: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingVertical: 10,
    alignItems: 'center',
    marginRight: 4,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  langButtonActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.3,
    elevation: 4,
  },
  langText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  langTextActive: {
    color: '#fff',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  methodsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  methodButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    marginRight: 8,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  methodButtonActive: {
    backgroundColor: '#DBEAFE',
    borderColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.2,
    elevation: 3,
  },
  methodText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  methodTextActive: {
    color: '#2563EB',
    fontWeight: '700',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  saveInputsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D1FAE5',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#059669',
    gap: 6,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  saveInputsButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
  },
  nextButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 14,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  nextButtonText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#fff',
    marginRight: 6,
    letterSpacing: -0.3,
  },
  imagesContainer: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#fff',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    marginRight: 12,
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    marginLeft: 6,
  },
  submitButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    borderRadius: 10,
    paddingVertical: 14,
  },
  submitButtonDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 12,
    marginBottom: 20,
    gap: 8,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    marginRight: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  // Progress UI styles
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 22,
    width: '85%',
    maxWidth: 340,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 14,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.05)',
  },
  progressHeader: {
    alignItems: 'center',
    marginBottom: 16,
  },
  progressIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    textAlign: 'center',
  },
  progressStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
  },
  progressStat: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  progressStatValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  progressStatLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  progressStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#E5E7EB',
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 12,
  },
  stepsContainer: {
    width: '100%',
    marginTop: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  stepText: {
    fontSize: 13,
    color: '#374151',
    marginLeft: 8,
    flex: 1,
  },
  stepTextDone: {
    color: '#059669',
  },
  stepDuration: {
    fontSize: 11,
    color: '#9CA3AF',
    marginLeft: 8,
  },
  progressHint: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 8,
  },
  // Restore modal styles
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
    elevation: 12,
  },
  restoreModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  restoreModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 8,
    textAlign: 'center',
  },
  restoreModalText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  restoreModalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  restoreModalBtnDiscard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#FEE2E2',
    gap: 6,
  },
  restoreModalBtnDiscardText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#EF4444',
  },
  restoreModalBtnRestore: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#2563EB',
    gap: 6,
  },
  restoreModalBtnRestoreText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
});

export default AssetFormSheet;
