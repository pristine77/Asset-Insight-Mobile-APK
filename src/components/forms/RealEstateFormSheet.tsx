import React, { useState, useEffect, useRef } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import realEstateService, { RealEstateDetails } from '../../services/realEstateService';

interface RealEstateFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const RealEstateFormSheet: React.FC<RealEstateFormSheetProps> = ({ visible, onClose, onSuccess }) => {
  const { user } = useAuth();

  // Property type
  const [propertyType, setPropertyType] = useState<'residential' | 'commercial' | 'agricultural'>('residential');
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>('en');

  // Property Details
  const [ownerName, setOwnerName] = useState('');
  const [address, setAddress] = useState('');
  const [landDescription, setLandDescription] = useState('');
  const [municipality, setMunicipality] = useState('');
  const [titleNumber, setTitleNumber] = useState('');
  const [parcelNumber, setParcelNumber] = useState('');
  const [landAreaAcres, setLandAreaAcres] = useState('');

  // Report Dates
  const [reportDate, setReportDate] = useState(isoDate(new Date()));
  const [effectiveDate, setEffectiveDate] = useState(isoDate(new Date()));
  const [inspectionDate, setInspectionDate] = useState(isoDate(new Date()));

  // House Details
  const [yearBuilt, setYearBuilt] = useState('');
  const [squareFootage, setSquareFootage] = useState('');
  const [lotSizeSqft, setLotSizeSqft] = useState('');
  const [numberOfRooms, setNumberOfRooms] = useState('');
  const [numberOfFullBathrooms, setNumberOfFullBathrooms] = useState('');
  const [numberOfHalfBathrooms, setNumberOfHalfBathrooms] = useState('');
  const [knownIssues, setKnownIssues] = useState('');

  // Inspector Info
  const [inspectorName, setInspectorName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [credentials, setCredentials] = useState('');

  // Images state
  const [images, setImages] = useState<Array<{ uri: string; name: string; type: string }>>([]);
  const [mapImage, setMapImage] = useState<{ uri: string; name: string; type: string } | null>(null);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setInspectorName((user as any)?.username || '');
      setContactEmail((user as any)?.email || '');
      setCompanyName((user as any)?.companyName || '');
      setContactPhone((user as any)?.contactPhone || '');
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

  const clearError = (field: string) => {
    setErrors((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!ownerName.trim()) newErrors.ownerName = 'Required';
    if (!address.trim()) newErrors.address = 'Required';
    if (!inspectorName.trim()) newErrors.inspectorName = 'Required';
    if (!contactEmail.trim()) newErrors.contactEmail = 'Required';
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
        selectionLimit: 20 - images.length,
      });

      if (!result.canceled && result.assets) {
        const newImages = result.assets.map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName || `image_${Date.now()}_${index}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        }));
        setImages((prev) => [...prev, ...newImages].slice(0, 20));
        clearError('images');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick images');
    }
  };

  const pickMapImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setMapImage({
          uri: asset.uri,
          name: asset.fileName || `map_${Date.now()}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick map image');
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const startPolling = (id: string) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const progress = await realEstateService.getProgress(id);
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
      const details: RealEstateDetails = {
        language,
        property_type: propertyType,
        property_details: {
          owner_name: ownerName,
          address,
          land_description: landDescription,
          municipality,
          title_number: titleNumber,
          parcel_number: parcelNumber,
          land_area_acres: landAreaAcres,
          source_quarter_section: '',
        },
        report_dates: {
          report_date: reportDate,
          effective_date: effectiveDate,
          inspection_date: inspectionDate,
        },
        house_details: {
          year_built: yearBuilt,
          square_footage: squareFootage,
          lot_size_sqft: lotSizeSqft,
          number_of_rooms: numberOfRooms,
          number_of_full_bathrooms: numberOfFullBathrooms,
          number_of_half_bathrooms: numberOfHalfBathrooms,
          known_issues: knownIssues.split(',').map((s) => s.trim()).filter(Boolean),
        },
        inspector_info: {
          inspector_name: inspectorName,
          company_name: companyName,
          contact_email: contactEmail,
          contact_phone: contactPhone,
          credentials,
        },
      };

      const response = await realEstateService.create(
        details,
        images,
        mapImage || undefined,
        (progress) => {
          setUploadProgress(progress);
        }
      );

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
    setOwnerName('');
    setAddress('');
    setLandDescription('');
    setMunicipality('');
    setTitleNumber('');
    setParcelNumber('');
    setLandAreaAcres('');
    setYearBuilt('');
    setSquareFootage('');
    setLotSizeSqft('');
    setNumberOfRooms('');
    setNumberOfFullBathrooms('');
    setNumberOfHalfBathrooms('');
    setKnownIssues('');
    setCredentials('');
    setImages([]);
    setMapImage(null);
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
          <Text style={styles.headerTitle}>Real Estate Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.headerIcon}>
              <Feather name="home" size={20} color="#2563EB" />
            </View>
          </View>
        </View>

        {/* Progress Overlay */}
        {(progressPhase === 'uploading' || progressPhase === 'processing') && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <ActivityIndicator size="large" color="#2563EB" />
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
            {/* Property Type Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Type</Text>
              <View style={styles.typeRow}>
                {(['residential', 'commercial', 'agricultural'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.typeButton, propertyType === type && styles.typeButtonActive]}
                    onPress={() => setPropertyType(type)}>
                    <Feather
                      name={type === 'residential' ? 'home' : type === 'commercial' ? 'briefcase' : 'sun'}
                      size={18}
                      color={propertyType === type ? '#fff' : '#6B7280'}
                    />
                    <Text style={[styles.typeText, propertyType === type && styles.typeTextActive]}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Property Details Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Details</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Owner Name *</Text>
                <TextInput
                  style={[styles.input, errors.ownerName && styles.inputError]}
                  value={ownerName}
                  onChangeText={(t) => {
                    setOwnerName(t);
                    clearError('ownerName');
                  }}
                  placeholder="Enter owner name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Property Address *</Text>
                <TextInput
                  style={[styles.input, styles.textArea, errors.address && styles.inputError]}
                  value={address}
                  onChangeText={(t) => {
                    setAddress(t);
                    clearError('address');
                  }}
                  placeholder="Enter full property address"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={2}
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Land Description</Text>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  value={landDescription}
                  onChangeText={setLandDescription}
                  placeholder="Describe the land..."
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={3}
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Municipality</Text>
                  <TextInput
                    style={styles.input}
                    value={municipality}
                    onChangeText={setMunicipality}
                    placeholder="Municipality"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Land Area (Acres)</Text>
                  <TextInput
                    style={styles.input}
                    value={landAreaAcres}
                    onChangeText={setLandAreaAcres}
                    placeholder="0.00"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Title Number</Text>
                  <TextInput
                    style={styles.input}
                    value={titleNumber}
                    onChangeText={setTitleNumber}
                    placeholder="Title #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Parcel Number</Text>
                  <TextInput
                    style={styles.input}
                    value={parcelNumber}
                    onChangeText={setParcelNumber}
                    placeholder="Parcel #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>
            </View>

            {/* Report Dates Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Report Dates</Text>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Report Date</Text>
                  <TextInput
                    style={styles.input}
                    value={reportDate}
                    onChangeText={setReportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Effective Date</Text>
                  <TextInput
                    style={styles.input}
                    value={effectiveDate}
                    onChangeText={setEffectiveDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Inspection Date</Text>
                <TextInput
                  style={styles.input}
                  value={inspectionDate}
                  onChangeText={setInspectionDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* House Details Section (for residential) */}
            {propertyType === 'residential' && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>House Details</Text>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Year Built</Text>
                    <TextInput
                      style={styles.input}
                      value={yearBuilt}
                      onChangeText={setYearBuilt}
                      placeholder="2000"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Square Footage</Text>
                    <TextInput
                      style={styles.input}
                      value={squareFootage}
                      onChangeText={setSquareFootage}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Lot Size (sqft)</Text>
                    <TextInput
                      style={styles.input}
                      value={lotSizeSqft}
                      onChangeText={setLotSizeSqft}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Rooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfRooms}
                      onChangeText={setNumberOfRooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Full Bathrooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfFullBathrooms}
                      onChangeText={setNumberOfFullBathrooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Half Bathrooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfHalfBathrooms}
                      onChangeText={setNumberOfHalfBathrooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>Known Issues (comma separated)</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    value={knownIssues}
                    onChangeText={setKnownIssues}
                    placeholder="e.g., Roof leak, Foundation crack"
                    placeholderTextColor="#9CA3AF"
                    multiline
                    numberOfLines={2}
                  />
                </View>
              </View>
            )}

            {/* Inspector Info Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Inspector Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Inspector Name *</Text>
                <TextInput
                  style={[styles.input, errors.inspectorName && styles.inputError]}
                  value={inspectorName}
                  onChangeText={(t) => {
                    setInspectorName(t);
                    clearError('inspectorName');
                  }}
                  placeholder="Enter inspector name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Name</Text>
                <TextInput
                  style={styles.input}
                  value={companyName}
                  onChangeText={setCompanyName}
                  placeholder="Enter company name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Email *</Text>
                  <TextInput
                    style={[styles.input, errors.contactEmail && styles.inputError]}
                    value={contactEmail}
                    onChangeText={(t) => {
                      setContactEmail(t);
                      clearError('contactEmail');
                    }}
                    placeholder="Email"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Phone</Text>
                  <TextInput
                    style={styles.input}
                    value={contactPhone}
                    onChangeText={setContactPhone}
                    placeholder="Phone"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="phone-pad"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Credentials</Text>
                <TextInput
                  style={styles.input}
                  value={credentials}
                  onChangeText={setCredentials}
                  placeholder="e.g., CRA, MAI"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* Settings Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Settings</Text>

              <View style={styles.fieldContainer}>
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

            {/* Images Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Images</Text>

              <TouchableOpacity
                style={[styles.addImageButton, errors.images && styles.addImageButtonError]}
                onPress={pickImages}>
                <Feather name="image" size={24} color="#2563EB" />
                <Text style={styles.addImageText}>Add Images ({images.length}/20)</Text>
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

              {/* Map Image */}
              <View style={styles.mapSection}>
                <Text style={styles.fieldLabel}>Map/Survey Image (Optional)</Text>
                <TouchableOpacity style={styles.addMapButton} onPress={pickMapImage}>
                  <Feather name="map" size={20} color="#2563EB" />
                  <Text style={styles.addMapText}>
                    {mapImage ? 'Change Map Image' : 'Add Map Image'}
                  </Text>
                </TouchableOpacity>
                {mapImage && (
                  <View style={styles.mapPreviewContainer}>
                    <Image source={{ uri: mapImage.uri }} style={styles.mapPreview} />
                    <TouchableOpacity
                      style={styles.removeMapButton}
                      onPress={() => setMapImage(null)}>
                      <Feather name="x" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
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
    backgroundColor: '#DBEAFE',
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
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    gap: 6,
  },
  typeButtonActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  typeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  typeTextActive: {
    color: '#fff',
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
  errorText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
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
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
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
    borderColor: '#2563EB',
    borderRadius: 12,
    backgroundColor: '#EFF6FF',
    gap: 8,
  },
  addImageButtonError: {
    borderColor: '#EF4444',
  },
  addImageText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2563EB',
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
  mapSection: {
    marginTop: 16,
  },
  addMapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#2563EB',
    borderRadius: 8,
    backgroundColor: '#fff',
    gap: 8,
  },
  addMapText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2563EB',
  },
  mapPreviewContainer: {
    marginTop: 12,
    position: 'relative',
    alignSelf: 'flex-start',
  },
  mapPreview: {
    width: 120,
    height: 120,
    borderRadius: 8,
  },
  removeMapButton: {
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
    backgroundColor: '#2563EB',
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
    backgroundColor: '#2563EB',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 8,
    textAlign: 'center',
  },
});

export default RealEstateFormSheet;
