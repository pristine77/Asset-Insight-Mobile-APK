import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  AndroidUpdateInfo,
  checkAndroidUpdate,
  downloadAndOpenAndroidApk,
} from '../services/appVersionService';

const DISMISSED_VERSION_KEY = 'cv_dismissed_android_apk_version_code';

export default function AppUpdatePrompt() {
  const [update, setUpdate] = useState<AndroidUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (Platform.OS !== 'android' || checkingRef.current || downloadingRef.current) return;

    try {
      checkingRef.current = true;
      setChecking(true);
      const nextUpdate = await checkAndroidUpdate();
      if (!mountedRef.current) return;
      if (!nextUpdate) {
        setUpdate(null);
        return;
      }

      if (!nextUpdate.mandatory) {
        const dismissed = await AsyncStorage.getItem(DISMISSED_VERSION_KEY).catch(() => null);
        if (dismissed === String(nextUpdate.latestVersionCode)) {
          return;
        }
      }

      setUpdate(nextUpdate);
    } catch {
      // Version checks should never block normal app startup unless a valid mandatory update is known.
    } finally {
      checkingRef.current = false;
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void runCheck();

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void runCheck();
      }
    });

    return () => {
      mountedRef.current = false;
      subscription.remove();
    };
  }, [runCheck]);

  const dismiss = async () => {
    if (!update || update.mandatory) return;
    await AsyncStorage.setItem(DISMISSED_VERSION_KEY, String(update.latestVersionCode)).catch(() => {});
    setUpdate(null);
  };

  const startUpdate = async () => {
    if (!update) return;
    try {
      downloadingRef.current = true;
      setDownloading(true);
      await downloadAndOpenAndroidApk(update);
    } catch (error: any) {
      Alert.alert(
        'Update failed',
        error?.message ||
          'Unable to start the Android installer. You may need to allow installing unknown apps in Android settings.'
      );
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  };

  if (!update) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={update.mandatory ? () => {} : dismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Feather name="download-cloud" size={28} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Update available</Text>
          <Text style={styles.subtitle}>
            Asset Insight v{update.latestVersionName} is ready to install.
          </Text>
          {update.mandatory ? (
            <View style={styles.mandatoryPill}>
              <Text style={styles.mandatoryText}>Required update</Text>
            </View>
          ) : null}
          {update.releaseNotes ? (
            <View style={styles.notesBox}>
              <Text style={styles.notesTitle}>What's new</Text>
              <Text style={styles.notesText}>{update.releaseNotes}</Text>
            </View>
          ) : null}
          <Text style={styles.helperText}>
            Android will open the installer after download. If prompted, allow this app to install updates.
          </Text>
          <View style={styles.actions}>
            {!update.mandatory ? (
              <TouchableOpacity style={styles.secondaryBtn} onPress={dismiss} disabled={downloading}>
                <Text style={styles.secondaryText}>Later</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.primaryBtn, downloading && styles.primaryBtnDisabled]}
              onPress={startUpdate}
              disabled={downloading}
            >
              {downloading ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
              <Text style={styles.primaryText}>{downloading ? 'Downloading...' : 'Update'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 18,
  },
  iconWrap: {
    width: 58,
    height: 58,
    borderRadius: 20,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '900',
    color: '#111827',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 23,
    color: '#475569',
    fontWeight: '600',
  },
  mandatoryPill: {
    alignSelf: 'flex-start',
    marginTop: 14,
    borderRadius: 999,
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  mandatoryText: {
    color: '#B91C1C',
    fontWeight: '900',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  notesBox: {
    marginTop: 18,
    borderRadius: 18,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 14,
  },
  notesTitle: {
    color: '#111827',
    fontWeight: '900',
    marginBottom: 6,
  },
  notesText: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 20,
  },
  helperText: {
    marginTop: 16,
    color: '#64748B',
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    marginTop: 22,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 15,
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  primaryBtnDisabled: {
    opacity: 0.74,
  },
  primaryText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 15,
  },
});
