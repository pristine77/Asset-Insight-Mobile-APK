import NetInfo from '@react-native-community/netinfo';
import axios from 'axios';
import { API_BASE_URL } from '../config/api';

export type ConnectivityStatus = 'online' | 'offline' | 'server_unreachable' | 'unknown';

export type ConnectivityResult = {
  status: ConnectivityStatus;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
};

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function getErrorStatus(error: any): number | undefined {
  const value = Number(error?.response?.status ?? error?.status);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function isNetworkTransportError(error: any): boolean {
  if (!error) return false;
  if (getErrorStatus(error)) return false;
  if (error?.isRecoverableUploadError === true) return true;
  if (error?.request && !error?.response) return true;

  const code = String(error?.code || '').toUpperCase();
  if (
    [
      'ECONNABORTED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EAI_AGAIN',
      'ERR_NETWORK',
      'ERR_INTERNET_DISCONNECTED',
    ].includes(code)
  ) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('network error') ||
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('connection reset') ||
    message.includes('connection was interrupted') ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

export function isRetryableRequestError(error: any): boolean {
  const status = getErrorStatus(error);
  return status ? TRANSIENT_HTTP_STATUSES.has(status) : isNetworkTransportError(error);
}

export function getServerErrorMessage(error: any): string {
  const body = error?.response?.data;
  if (typeof body === 'string' && body.trim()) return body.trim();
  const message = body?.message || body?.error;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return typeof error?.message === 'string' ? error.message.trim() : '';
}

export async function getConnectivityStatus(): Promise<ConnectivityResult> {
  const network = await NetInfo.fetch().catch(() => null);
  const isConnected = network?.isConnected ?? null;
  const isInternetReachable = network?.isInternetReachable ?? null;

  if (isConnected === false) {
    return { status: 'offline', isConnected, isInternetReachable };
  }

  try {
    // This endpoint intentionally requires no authentication. An expired token
    // must never make an online report look like an offline report.
    await axios.get(`${API_BASE_URL}/health`, {
      timeout: 6000,
      validateStatus: () => true,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return { status: 'online', isConnected, isInternetReachable };
  } catch {
    if (isInternetReachable === false) {
      return { status: 'offline', isConnected, isInternetReachable };
    }
    if (isConnected === true && isInternetReachable === true) {
      return { status: 'server_unreachable', isConnected, isInternetReachable };
    }
    return { status: 'unknown', isConnected, isInternetReachable };
  }
}

export async function shouldQueueAfterError(error: any): Promise<boolean> {
  if (!isNetworkTransportError(error)) return false;
  const connectivity = await getConnectivityStatus();
  return connectivity.status === 'offline';
}

export function getSubmissionError(error: any): { title: string; message: string } {
  const status = getErrorStatus(error);
  const serverMessage = getServerErrorMessage(error);

  if (status === 401 || status === 403) {
    return {
      title: 'Sign In Required',
      message: 'Your session has expired. Sign in again, then retry. Your report remains saved.',
    };
  }
  if (status === 408 || status === 425 || status === 429) {
    return {
      title: 'Upload Delayed',
      message: serverMessage || 'The server is busy. Your report remains saved; wait a moment and retry.',
    };
  }
  if (status && status >= 400 && status < 500) {
    return {
      title: 'Report Needs Attention',
      message: serverMessage || 'The report was not accepted. Review the entered information and try again.',
    };
  }
  if (status && status >= 500) {
    return {
      title: 'Server Temporarily Unavailable',
      message: serverMessage || 'The server could not complete the upload. Your report remains saved; try again shortly.',
    };
  }
  if (isNetworkTransportError(error)) {
    return {
      title: 'Upload Interrupted',
      message: 'The upload connection was interrupted. Your report remains saved. Check the connection and tap Submit again.',
    };
  }
  return {
    title: 'Submission Failed',
    message: serverMessage || 'The report could not be submitted. Your work remains saved.',
  };
}
