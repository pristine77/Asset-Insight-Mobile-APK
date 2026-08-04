import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import authService, { User, LoginCredentials, type AuthResponse } from "../services/authService";
import offlineQueueService from "../services/offlineQueueService";
import { unregisterStoredPushTokenFromServer } from "../services/notificationService";
import deviceAccessService from "../services/deviceAccessService";
import {
  getPersistedDeviceAccess,
  persistDeviceAccess,
  subscribeDeviceAccess,
  subscribeSessionInvalidated,
  type RestrictedDeviceAccess,
} from "../services/deviceAccessStorage";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  deviceAccess: RestrictedDeviceAccess | null;
  login: (credentials: LoginCredentials) => Promise<AuthResponse>;
  registerDevice: () => Promise<void>;
  refreshDeviceStatus: () => Promise<void>;
  rerequestDevice: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceAccess, setDeviceAccess] = useState<RestrictedDeviceAccess | null>(null);
  const statusRequest = useRef<Promise<void> | null>(null);

  const refreshUser = useCallback(async () => {
    const currentUser =
      (await authService.refreshCurrentUser()) ||
      (await authService.getCurrentUser());
    setUser(currentUser);
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      setLoading(true);
      const restricted = await getPersistedDeviceAccess();
      if (restricted) {
        setDeviceAccess(restricted);
        setUser(null);
        offlineQueueService.cleanup();
        return;
      }
      const isAuth = await authService.isAuthenticated();
      if (isAuth) {
        await refreshUser();
        offlineQueueService.init();
      }
    } catch (err) {
      console.error("Auth check failed:", err);
    } finally {
      setLoading(false);
    }
  }, [refreshUser]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    return subscribeDeviceAccess((state) => {
      setDeviceAccess(state);
      if (state) {
        setUser(null);
        offlineQueueService.cleanup();
      }
    });
  }, []);

  useEffect(() => {
    return subscribeSessionInvalidated(() => {
      setUser(null);
      setDeviceAccess(null);
      setError("Your device session is no longer valid. Sign in again to continue.");
      offlineQueueService.cleanup();
    });
  }, []);

  const login = async (credentials: LoginCredentials) => {
    try {
      setLoading(true);
      setError(null);
      const response = await authService.login(credentials);
      if (response.authState === "authenticated") {
        setUser(response.user);
        setDeviceAccess(null);
        offlineQueueService.init();
      } else {
        setUser(null);
        setDeviceAccess(response);
        offlineQueueService.cleanup();
      }
      return response;
    } catch (err: any) {
      const message = err.response?.data?.message || err.message || "Login failed";
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const exchangeApproval = useCallback(async () => {
    const response = await deviceAccessService.exchange();
    setUser(response.user);
    setDeviceAccess(null);
    setError(null);
    offlineQueueService.init();
  }, []);

  const registerDevice = useCallback(async () => {
    const response = await deviceAccessService.register();
    if ((response as unknown as { authState?: string }).authState === "approved") {
      await exchangeApproval();
      return;
    }
    setDeviceAccess(response);
  }, [exchangeApproval]);

  const refreshDeviceStatus = useCallback(() => {
    if (statusRequest.current) return statusRequest.current;
    const request = (async () => {
      const response = await deviceAccessService.status();
      const status = response.status || response.authState;
      if (status === "approved") {
        await exchangeApproval();
        return;
      }
      const next = { ...response, authState: status } as RestrictedDeviceAccess;
      await persistDeviceAccess(next);
      setDeviceAccess(next);
    })().finally(() => {
      statusRequest.current = null;
    });
    statusRequest.current = request;
    return request;
  }, [exchangeApproval]);

  const rerequestDevice = useCallback(async () => {
    const response = await deviceAccessService.rerequest();
    setDeviceAccess(response);
  }, []);

  const logout = async () => {
    try {
      setLoading(true);
      offlineQueueService.cleanup();
      await unregisterStoredPushTokenFromServer().catch((error) => {
        console.error("Notification token cleanup failed:", error);
      });
      await authService.logout();
      setUser(null);
      setDeviceAccess(null);
    } catch (err) {
      console.error("Logout failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const clearError = () => setError(null);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        deviceAccess,
        login,
        registerDevice,
        refreshDeviceStatus,
        rerequestDevice,
        logout,
        refreshUser,
        error,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
