import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Localization from 'expo-localization';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import salvageService, { SalvageDetails, ProgressData } from '../../services/salvageService';

// Currency codes by region/locale
const CURRENCY_MAP: Record<string, string> = {
  'en-US': 'USD',
  'en-CA': 'CAD',
  'en-GB': 'GBP',
  'en-AU': 'AUD',
  'fr-CA': 'CAD',
  'fr-FR': 'EUR',
  'es-ES': 'EUR',
  'es-MX': 'MXN',
};

interface SalvageFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const SalvageFormSheet: React.FC<SalvageFormSheetProps> = ({ visible, onClose, onSuccess }) => {
  const { user } = useAuth();

  // Form fields
  const [reportDate, setReportDate] = useState(isoDate(new Date()));
  const [fileNumber, setFileNumber] = useState('');
  const [dateReceived, setDateReceived] = useState(isoDate(new Date()));
  const [claimNumber, setClaimNumber] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [appraiserName, setAppraiserName] = useState('');
  const [appraiserPhone, setAppraiserPhone] = useState('');
  const [appraiserEmail, setAppraiserEmail] = useState('');
  const [adjusterName, setAdjusterName] = useState('');
  const [insuredName, setInsuredName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [appraiserComments, setAppraiserComments] = useState('');
  const [nextReportDue, setNextReportDue] = useState(isoDate(new Date()));
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>('en');
  const [currency, setCurrency] = useState('');
  const [currencyLoading, setCurrencyLoading] = useState(false);

  // Images state
  const [images, setImages] = useState<Array<{ uri: string; name: string; type: string }>>([]);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-detect currency on mount
  useEffect(() => {
    if (!currency && visible) {
      detectCurrency();
    }
  }, [visible]);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setAppraiserName((user as any)?.username || '');
      setAppraiserEmail((user as any)?.email || '');
      setCompanyName((user as any)?.companyName || '');
      setCompanyAddress((user as any)?.companyAddress || '');
      setAppraiserPhone((user as any)?.contactPhone || '');
    }
  }, [user, visible]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const detectCurrency = async () => {
    setCurrencyLoading(true);
    try {
      const locales = Localization.getLocales();
      const locale = locales[0];
      const localeTag = locale?.languageTag || 'en-US';

      let detectedCurrency = CURRENCY_MAP[localeTag];

      if (!detectedCurrency && locale?.regionCode) {
        const regionMap: Record<string, string> = {
          US: 'USD',
          CA: 'CAD',
          GB: 'GBP',
          AU: 'AUD',
          NZ: 'NZD',
          IN: 'INR',
          EU: 'EUR',
        };
        detectedCurrency = regionMap[locale.regionCode];
      }

      setCurrency(detectedCurrency || 'CAD');
    } catch (error) {
      setCurrency('CAD');
    } finally {
      setCurrencyLoading(false);
    }
  };

  const clearError = (field: string) => {
    setErrors((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!fileNumber.trim()) newErrors.fileNumber = 'Required';
    if (!claimNumber.trim()) newErrors.claimNumber = 'Required';
    if (!policyNumber.trim()) newErrors.policyNumber = 'Required';
    if (!appraiserName.trim()) newErrors.appraiserName = 'Required';
    if (!appraiserPhone.trim()) newErrors.appraiserPhone = 'Required';
    if (!appraiserEmail.trim()) newErrors.appraiserEmail = 'Required';
    if (!adjusterName.trim()) newErrors.adjusterName = 'Required';
    if (!insuredName.trim()) newErrors.insuredName = 'Required';
    if (!companyName.trim()) newErrors.companyName = 'Required';
    if (!companyAddress.trim()) newErrors.companyAddress = 'Required';
    if (!appraiserComments.trim()) newErrors.appraiserComments = 'Required';
    if (!currency || !/^[A-Z]{3}$/.test(currency)) newErrors.currency = 'Use 3-letter code';
    if (images.length === 0) newErrors.images = 'At least one image required';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const pickImages = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: 30 - images.length,
      });

      if (!result.canceled && result.assets) {
        const newImages = result.assets.map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName || `image_${Date.now()}_${index}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        }));
        setImages((prev) => [...prev, ...newImages].slice(0, 30));
        clearError('images');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick images');
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const startPolling = (id: string) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const progress = await salvageService.getProgress(id);
        if (progress.phase === 'done') {
          clearInterval(pollIntervalRef.current!);
          setProgressPhase('done');
          Alert.alert('Success', 'Report created successfully!');
          resetForm();
          onSuccess?.();
          onClose();
        } else if (progress.phase === 'error') {
          clearInterval(pollIntervalRef.current!);
          setProgressPhase('error');
          Alert.alert('Error', progress.message || 'Failed to create report');
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 3000);
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      Alert.alert('Error', 'Please fill all required fields');
      return;
    }

    setSubmitting(true);
    setProgressPhase('uploading');
    setUploadProgress(0);

    try {
      const details: SalvageDetails = {
        report_date: reportDate,
        file_number: fileNumber,
        date_received: dateReceived,
        claim_number: claimNumber,
        policy_number: policyNumber,
        appraiser_name: appraiserName,
        appraiser_phone: appraiserPhone,
        appraiser_email: appraiserEmail,
        adjuster_name: adjusterName,
        insured_name: insuredName,
        company_name: companyName,
        company_address: companyAddress,
        appraiser_comments: appraiserComments,
        next_report_due: nextReportDue,
        language,
        currency,
      };

      const response = await salvageService.create(details, images, (progress) => {
        setUploadProgress(progress);
      });

      if (response.jobId) {
        setJobId(response.jobId);
        setProgressPhase('processing');
        startPolling(response.jobId);
      } else {
        setProgressPhase('done');
        Alert.alert('Success', response.message || 'Report submitted successfully!');
        resetForm();
        onSuccess?.();
        onClose();
      }
    } catch (error: any) {
      setProgressPhase('error');
      Alert.alert('Error', error?.response?.data?.message || error?.message || 'Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setFileNumber('');
    setClaimNumber('');
    setPolicyNumber('');
    setAdjusterName('');
    setInsuredName('');
    setAppraiserComments('');
    setImages([]);
    setProgressPhase('idle');
    setUploadProgress(0);
    setJobId(null);
    setErrors({});
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Salvage Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.headerIcon}>
              <Feather name="truck" size={20} color="#DC2626" />
            </View>
          </View>
        </View>

        {/* Progress Overlay */}
        {(progressPhase === 'uploading' || progressPhase === 'processing') && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <ActivityIndicator size="large" color="#DC2626" />
              <Text style={styles.progressTitle}>
                {progressPhase === 'uploading' ? 'Uploading...' : 'Processing...'}
              </Text>
              {progressPhase === 'uploading' && (
                <>
                  <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${uploadProgress}%` }]} />
                  </View>
                  <Text style={styles.progressText}>{uploadProgress}%</Text>
                </>
              )}
              {progressPhase === 'processing' && (
                <Text style={styles.progressText}>Your report is being generated...</Text>
              )}
            </View>
          </View>
        )}

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.content}>
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {/* Report Details Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Report Details</Text>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Report Date *</Text>
                  <TextInput
                    style={styles.input}
                    value={reportDate}
                    onChangeText={setReportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Date Received *</Text>
                  <TextInput
                    style={styles.input}
                    value={dateReceived}
                    onChangeText={setDateReceived}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>File Number *</Text>
                <TextInput
                  style={[styles.input, errors.fileNumber && styles.inputError]}
                  value={fileNumber}
                  onChangeText={(t) => {
                    setFileNumber(t);
                    clearError('fileNumber');
                  }}
                  placeholder="Enter file number"
                  placeholderTextColor="#9CA3AF"
                />
                {errors.fileNumber && <Text style={styles.errorText}>{errors.fileNumber}</Text>}
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Claim Number *</Text>
                  <TextInput
                    style={[styles.input, errors.claimNumber && styles.inputError]}
                    value={claimNumber}
                    onChangeText={(t) => {
                      setClaimNumber(t);
                      clearError('claimNumber');
                    }}
                    placeholder="Claim #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Policy Number *</Text>
                  <TextInput
                    style={[styles.input, errors.policyNumber && styles.inputError]}
                    value={policyNumber}
                    onChangeText={(t) => {
                      setPolicyNumber(t);
                      clearError('policyNumber');
                    }}
                    placeholder="Policy #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Next Report Due</Text>
                <TextInput
                  style={styles.input}
                  value={nextReportDue}
                  onChangeText={setNextReportDue}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* Parties Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Parties Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Insured Name *</Text>
                <TextInput
                  style={[styles.input, errors.insuredName && styles.inputError]}
                  value={insuredName}
                  onChangeText={(t) => {
                    setInsuredName(t);
                    clearError('insuredName');
                  }}
                  placeholder="Enter insured name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Adjuster Name *</Text>
                <TextInput
                  style={[styles.input, errors.adjusterName && styles.inputError]}
                  value={adjusterName}
                  onChangeText={(t) => {
                    setAdjusterName(t);
                    clearError('adjusterName');
                  }}
                  placeholder="Enter adjuster name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* Appraiser Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Appraiser Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Appraiser Name *</Text>
                <TextInput
                  style={[styles.input, errors.appraiserName && styles.inputError]}
                  value={appraiserName}
                  onChangeText={(t) => {
                    setAppraiserName(t);
                    clearError('appraiserName');
                  }}
                  placeholder="Enter appraiser name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Phone *</Text>
                  <TextInput
                    style={[styles.input, errors.appraiserPhone && styles.inputError]}
                    value={appraiserPhone}
                    onChangeText={(t) => {
                      setAppraiserPhone(t);
                      clearError('appraiserPhone');
                    }}
                    placeholder="Phone"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="phone-pad"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Email *</Text>
                  <TextInput
                    style={[styles.input, errors.appraiserEmail && styles.inputError]}
                    value={appraiserEmail}
                    onChangeText={(t) => {
                      setAppraiserEmail(t);
                      clearError('appraiserEmail');
                    }}
                    placeholder="Email"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Name *</Text>
                <TextInput
                  style={[styles.input, errors.companyName && styles.inputError]}
                  value={companyName}
                  onChangeText={(t) => {
                    setCompanyName(t);
                    clearError('companyName');
                  }}
                  placeholder="Enter company name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Address *</Text>
                <TextInput
                  style={[styles.input, styles.textArea, errors.companyAddress && styles.inputError]}
                  value={companyAddress}
                  onChangeText={(t) => {
                    setCompanyAddress(t);
                    clearError('companyAddress');
                  }}
                  placeholder="Enter company address"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={2}
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
                      <ActivityIndicator size="small" color="#DC2626" style={styles.currencyLoader} />
                    )}
                  </View>
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

            {/* Comments Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Comments</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Appraiser Comments *</Text>
                <TextInput
                  style={[styles.input, styles.textAreaLarge, errors.appraiserComments && styles.inputError]}
                  value={appraiserComments}
                  onChangeText={(t) => {
                    setAppraiserComments(t);
                    clearError('appraiserComments');
                  }}
                  placeholder="Enter detailed comments about the salvage..."
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={5}
                />
              </View>
            </View>

            {/* Images Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Images</Text>

              <TouchableOpacity
                style={[styles.addImageButton, errors.images && styles.addImageButtonError]}
                onPress={pickImages}>
                <Feather name="image" size={24} color="#DC2626" />
                <Text style={styles.addImageText}>Add Images ({images.length}/30)</Text>
              </TouchableOpacity>
              {errors.images && <Text style={styles.errorText}>{errors.images}</Text>}

              {images.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imagePreviewScroll}>
                  {images.map((img, index) => (
                    <View key={index} style={styles.imagePreviewContainer}>
                      <Image source={{ uri: img.uri }} style={styles.imagePreview} />
                      <TouchableOpacity
                        style={styles.removeImageButton}
                        onPress={() => removeImage(index)}>
                        <Feather name="x" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>

            {/* Submit Button */}
            <TouchableOpacity
              style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={submitting}>
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Text style={styles.submitButtonText}>Submit Report</Text>
                  <Feather name="send" size={18} color="#fff" />
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
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
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FEE2E2',
    justifyContent: 'center',
    alignItems: 'center',
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
    marginBottom: 24,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 12,
  },
  fieldContainer: {
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#EF4444',
  },
  textArea: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  textAreaLarge: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 4,
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
    marginLeft: 8,
  },
  languageRow: {
    flexDirection: 'row',
    gap: 8,
  },
  langButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
  },
  langButtonActive: {
    backgroundColor: '#DC2626',
    borderColor: '#DC2626',
  },
  langText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  langTextActive: {
    color: '#fff',
  },
  addImageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#DC2626',
    borderRadius: 12,
    backgroundColor: '#FEF2F2',
    gap: 8,
  },
  addImageButtonError: {
    borderColor: '#EF4444',
  },
  addImageText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#DC2626',
  },
  imagePreviewScroll: {
    marginTop: 12,
  },
  imagePreviewContainer: {
    marginRight: 8,
    position: 'relative',
  },
  imagePreview: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  removeImageButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
  },
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 320,
    alignItems: 'center',
  },
  progressTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    marginTop: 16,
    marginBottom: 12,
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#DC2626',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 8,
    textAlign: 'center',
  },
});

export default SalvageFormSheet;
