import AsyncStorage from "@react-native-async-storage/async-storage";
import api, { STORAGE_KEYS } from "./api";
import { API_ENDPOINTS } from "../config/api";
import { buildNativeDeviceContext } from "./deviceMetadataService";
import {
  clearDeviceAccess,
  clearSecureSession,
  getMemoryAccessToken,
  getRefreshToken,
  migrateLegacyTokens,
  persistDeviceAccess,
  setMemoryAccessToken,
  setRefreshToken,
  type RestrictedDeviceAccess,
} from "./deviceAccessStorage";

export interface User {
  _id: string;
  email: string;
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
  isVerified: boolean;
  isCrmAgent?: boolean;
  isReportApprover?: boolean;
  isReleaseManager?: boolean;
  crmAssignedAt?: string;
  role?: string;
  createdAt?: string;
}

export interface LoginResponse {
  authState: "authenticated";
  accessToken: string;
  refreshToken: string;
  user: User;
}

export type AuthResponse = LoginResponse | RestrictedDeviceAccess;

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  username: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmSpecializations?: string[];
}

export interface VerifyEmailPayload {
  email: string;
  verificationCode: string;
}

export interface AuthMessageResponse {
  message: string;
}

export interface ResetPasswordPayload {
  token: string;
  password: string;
}

export interface ResetPasswordCodePayload {
  email: string;
  code: string;
  password: string;
}

class AuthService {
  private async persistSession(accessToken: string, refreshToken: string, user?: User | null) {
    await AsyncStorage.multiRemove([STORAGE_KEYS.SESSION_EXPIRED]);
    setMemoryAccessToken(accessToken);
    await setRefreshToken(refreshToken);
    await clearDeviceAccess();

    if (user) {
      await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
      return user;
    }

    const refreshedUser = await this.refreshCurrentUser();
    if (refreshedUser) {
      await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(refreshedUser));
      return refreshedUser;
    }

    return null;
  }

  private async applyAuthResponse(data: AuthResponse): Promise<AuthResponse> {
    if (data.authState === "authenticated") {
      const user = await this.persistSession(data.accessToken, data.refreshToken, data.user);
      return { ...data, user: user || data.user };
    }
    await clearSecureSession();
    await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
    await persistDeviceAccess(data);
    return data;
  }

  async acceptAuthenticatedResponse(data: LoginResponse): Promise<LoginResponse> {
    return (await this.applyAuthResponse(data)) as LoginResponse;
  }

  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const { data } = (await api.post(API_ENDPOINTS.LOGIN, {
      ...credentials,
      deviceContext: await buildNativeDeviceContext(),
    })) as { data: AuthResponse };
    return this.applyAuthResponse(data);
  }

  async signup(payload: SignupPayload): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.SIGNUP, payload) as { data: AuthMessageResponse };
    return data;
  }

  async verifyEmail(payload: VerifyEmailPayload): Promise<AuthResponse & AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.VERIFY_EMAIL, {
      ...payload,
      deviceContext: await buildNativeDeviceContext(),
    }) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async resendVerificationCode(email: string): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.RESEND_VERIFICATION_CODE, { email }) as {
      data: AuthMessageResponse;
    };
    return data;
  }

  async forgotPassword(email: string): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.FORGOT_PASSWORD, {
      email,
      clientType: "mobile",
    }) as { data: AuthMessageResponse };
    return data;
  }

  async resetPassword(payload: ResetPasswordPayload): Promise<AuthResponse & AuthMessageResponse> {
    const { token, password } = payload;
    const { data } = await api.post(
      `${API_ENDPOINTS.RESET_PASSWORD}/${encodeURIComponent(token)}`,
      { password, deviceContext: await buildNativeDeviceContext() }
    ) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async resetPasswordByCode(payload: ResetPasswordCodePayload): Promise<AuthResponse & AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.RESET_PASSWORD_CODE, {
      ...payload,
      deviceContext: await buildNativeDeviceContext(),
    }) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async logout(): Promise<void> {
    try {
      const refreshToken = await getRefreshToken();
      if (refreshToken) {
        await api.post(API_ENDPOINTS.LOGOUT, { token: refreshToken }).catch(() => {});
      }
    } finally {
      await clearSecureSession();
      await clearDeviceAccess();
      await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
    }
  }

  async getCurrentUser(): Promise<User | null> {
    try {
      const userStr = await AsyncStorage.getItem(STORAGE_KEYS.USER);
      if (userStr) {
        return JSON.parse(userStr);
      }
      return null;
    } catch {
      return null;
    }
  }

  async refreshCurrentUser(): Promise<User | null> {
    try {
      const { data } = await api.get(API_ENDPOINTS.ME);
      if (!data) return null;
      await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data));
      return data as User;
    } catch {
      return null;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    await migrateLegacyTokens();
    return Boolean(getMemoryAccessToken() || (await getRefreshToken()));
  }

  async getStoredTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
    const accessToken = getMemoryAccessToken();
    const refreshToken = await getRefreshToken();
    return { accessToken, refreshToken };
  }
}

export default new AuthService();
