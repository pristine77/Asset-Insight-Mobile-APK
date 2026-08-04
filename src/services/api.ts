/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE_URL, API_ENDPOINTS } from "../config/api";
import {
  clearSecureSession,
  emitRestrictedDeviceAccess,
  emitSessionInvalidated,
  getDeviceKey,
  getMemoryAccessToken,
  getRefreshToken,
  setMemoryAccessToken,
} from "./deviceAccessStorage";
import { getAndroidReinstallId } from "./deviceReinstallIdentity";

// Storage keys
export const STORAGE_KEYS = {
  ACCESS_TOKEN: "cv_access_token",
  REFRESH_TOKEN: "cv_refresh_token",
  USER: "cv_user",
  SESSION_EXPIRED: "cv_session_expired",
};

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor - add auth token
api.interceptors.request.use(
  async (config: any) => {
    const token = getMemoryAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const [deviceKey, reinstallId] = await Promise.all([
      getDeviceKey(),
      getAndroidReinstallId(),
    ]);
    if (deviceKey && config.headers) {
      config.headers["X-Device-Key"] = deviceKey;
    }
    if (reinstallId && config.headers) {
      config.headers["X-Device-Reinstall-Id"] = reinstallId;
    }
    return config;
  },
  (error: any) => Promise.reject(error)
);

// Response interceptor - handle token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

const clearSessionAndSignalExpiry = async (refreshToken: string | null) => {
  try {
    if (refreshToken) {
      const [deviceKey, reinstallId] = await Promise.all([
        getDeviceKey(),
        getAndroidReinstallId(),
      ]);
      await axios.post(
        `${API_BASE_URL}${API_ENDPOINTS.LOGOUT}`,
        { token: refreshToken },
        {
          headers: {
            ...(deviceKey ? { "X-Device-Key": deviceKey } : {}),
            ...(reinstallId ? { "X-Device-Reinstall-Id": reinstallId } : {}),
          },
        }
      ).catch(() => {});
    }
  } finally {
    await clearSecureSession();
    await AsyncStorage.removeItem(STORAGE_KEYS.USER);
    await AsyncStorage.setItem(STORAGE_KEYS.SESSION_EXPIRED, "1");
    emitSessionInvalidated();
  }
};

const AUTH_STATE_BY_CODE: Record<string, string> = {
  DEVICE_CONTEXT_REQUIRED: "registration_required",
  DEVICE_PENDING: "pending",
  DEVICE_REREQUEST_PENDING: "rerequest_pending",
  DEVICE_REJECTED: "rejected",
  DEVICE_REVOKED: "revoked",
  IP_BLOCKED: "ip_blocked",
};

api.interceptors.response.use(
  (response: any) => response,
  async (error: any) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const responseData = error.response?.data;
    const code = String(responseData?.code || "");
    const restrictedCodes = new Set([
      "DEVICE_CONTEXT_REQUIRED",
      "DEVICE_PENDING",
      "DEVICE_REREQUEST_PENDING",
      "DEVICE_REJECTED",
      "DEVICE_REVOKED",
      "IP_BLOCKED",
    ]);

    if (restrictedCodes.has(code) || responseData?.authState === "ip_blocked") {
      const restricted = {
        ...(responseData || {}),
        code,
        authState: responseData?.authState || AUTH_STATE_BY_CODE[code],
      };
      await clearSecureSession();
      await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
      if (restricted.authState === "registration_required" && !restricted.challengeToken) {
        emitSessionInvalidated();
      } else {
        await emitRestrictedDeviceAccess(restricted);
      }
      return Promise.reject(error);
    }

    if ((status === 401 || status === 403) && originalRequest && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return api(originalRequest);
          })
          .catch((err: any) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = await getRefreshToken();
        if (!refreshToken) {
          processQueue(error, null);
          await clearSessionAndSignalExpiry(null);
          return Promise.reject(error);
        }

        const [deviceKey, reinstallId] = await Promise.all([
          getDeviceKey(),
          getAndroidReinstallId(),
        ]);
        const { data } = await axios.post(
          `${API_BASE_URL}${API_ENDPOINTS.REFRESH_TOKEN}`,
          { token: refreshToken },
          {
            headers: {
              ...(deviceKey ? { "X-Device-Key": deviceKey } : {}),
              ...(reinstallId ? { "X-Device-Reinstall-Id": reinstallId } : {}),
            },
          }
        );

        const newAccessToken = data.accessToken;
        setMemoryAccessToken(newAccessToken);

        processQueue(null, newAccessToken);

        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        }
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        const restricted = (refreshError as any)?.response?.data;
        const restrictedCode = String(restricted?.code || "");
        const normalized = {
          ...(restricted || {}),
          code: restrictedCode,
          authState: restricted?.authState || AUTH_STATE_BY_CODE[restrictedCode],
        };
        if (normalized.authState) {
          await clearSecureSession();
          await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
          if (normalized.authState === "registration_required" && !normalized.challengeToken) {
            emitSessionInvalidated();
          } else {
            await emitRestrictedDeviceAccess(normalized);
          }
          return Promise.reject(refreshError);
        }
        const storedRefreshToken = await getRefreshToken().catch(() => null);
        await clearSessionAndSignalExpiry(storedRefreshToken);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
