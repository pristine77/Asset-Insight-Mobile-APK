import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import { API_BASE_URL } from '../config/api';

const FileSystem = require('expo-file-system/legacy');

const APK_MIME_TYPE = 'application/vnd.android.package-archive';

export type AndroidUpdateInfo = {
  latestVersionName: string;
  latestVersionCode: number;
  releaseNotes: string;
  mandatory: boolean;
  downloadUrl: string;
  sizeBytes?: number;
  sha256?: string;
};

function parseVersionCode(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9]/g, ''));
    return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
  }
  return 0;
}

export function getInstalledAndroidVersionCode(): number {
  const nativeBuild = parseVersionCode(Application.nativeBuildVersion);
  if (nativeBuild > 0) return nativeBuild;

  const expoConfig = Constants.expoConfig as any;
  const configBuild = parseVersionCode(expoConfig?.android?.versionCode);
  if (configBuild > 0) return configBuild;

  return 1;
}

export async function checkAndroidUpdate(): Promise<AndroidUpdateInfo | null> {
  if (Platform.OS !== 'android') return null;

  const currentVersionCode = getInstalledAndroidVersionCode();
  const response = await fetch(
    `${API_BASE_URL}/app-version/android/latest?currentVersionCode=${encodeURIComponent(String(currentVersionCode))}`,
    { method: 'GET' }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || 'Unable to check app version');
  }
  if (!data?.available || !data?.updateAvailable || !data?.downloadUrl) {
    return null;
  }

  return {
    latestVersionName: String(data.latestVersionName || data.versionName || ''),
    latestVersionCode: Number(data.latestVersionCode || data.versionCode || 0),
    releaseNotes: String(data.releaseNotes || ''),
    mandatory: Boolean(data.mandatory),
    downloadUrl: String(data.downloadUrl),
    sizeBytes: Number(data.sizeBytes || 0),
    sha256: data.sha256 ? String(data.sha256) : undefined,
  };
}

export async function downloadAndOpenAndroidApk(update: AndroidUpdateInfo): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!update.downloadUrl) throw new Error('APK download URL is missing');

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) throw new Error('Device storage is not available for APK download');

  const apkPath = `${baseDir}asset-insight-${update.latestVersionCode}.apk`;
  await FileSystem.deleteAsync(apkPath, { idempotent: true }).catch(() => {});

  const result = await FileSystem.downloadAsync(update.downloadUrl, apkPath, {
    headers: { Accept: APK_MIME_TYPE },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`APK download failed with status ${result.status}`);
  }

  const contentUri =
    typeof FileSystem.getContentUriAsync === 'function'
      ? await FileSystem.getContentUriAsync(result.uri)
      : result.uri;

  const viewAction =
    (IntentLauncher as any).ActivityAction?.VIEW || 'android.intent.action.VIEW';
  await IntentLauncher.startActivityAsync(viewAction, {
    data: contentUri,
    type: APK_MIME_TYPE,
    flags: 1 | 268435456,
  });
}
