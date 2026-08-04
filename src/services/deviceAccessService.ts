import api from "./api";
import authService, { type LoginResponse } from "./authService";
import {
  getDeviceKey,
  getPersistedDeviceAccess,
  persistDeviceAccess,
  type RestrictedDeviceAccess,
} from "./deviceAccessStorage";
import { collectVerifiedNativeDeviceContext } from "./deviceMetadataService";

async function headers() {
  const [state, deviceKey] = await Promise.all([
    getPersistedDeviceAccess(),
    getDeviceKey(),
  ]);
  if (!state?.challengeToken || !deviceKey) {
    throw new Error("This device request expired. Sign in again.");
  }
  return {
    Authorization: `Bearer ${state.challengeToken}`,
    "X-Device-Key": deviceKey,
  };
}

class DeviceAccessService {
  async register() {
    const context = await collectVerifiedNativeDeviceContext();
    const { data } = await api.post(
      "/auth/device-requests/register",
      {
        reinstallId: context.reinstallId,
        platform: context.platform,
        formFactor: context.formFactor,
        displayName: context.displayName,
        metadata: context.metadata,
      },
      { headers: await headers() }
    );
    await persistDeviceAccess(data as RestrictedDeviceAccess);
    return data as RestrictedDeviceAccess & { authState?: string };
  }

  async status() {
    const current = await getPersistedDeviceAccess();
    const { data } = await api.get("/auth/device-requests/status", {
      headers: await headers(),
    });
    const status = String(data?.status || data?.authState || "");
    if (status && status !== "approved") {
      const next = {
        ...current,
        ...data,
        authState: status,
        challengeToken: data?.challengeToken || current?.challengeToken,
        challengeExpiresAt: data?.challengeExpiresAt || current?.challengeExpiresAt,
      } as RestrictedDeviceAccess;
      await persistDeviceAccess(next);
      return next;
    }
    return data as RestrictedDeviceAccess & { status?: string };
  }

  async exchange() {
    const { data } = await api.post(
      "/auth/device-requests/exchange",
      {},
      { headers: await headers() }
    );
    return authService.acceptAuthenticatedResponse(data as LoginResponse);
  }

  async rerequest() {
    const context = await collectVerifiedNativeDeviceContext();
    const { data } = await api.post(
      "/auth/device-requests/rerequest",
      {
        reinstallId: context.reinstallId,
        displayName: context.displayName,
        platform: context.platform,
        formFactor: context.formFactor,
        metadata: context.metadata,
      },
      { headers: await headers() }
    );
    await persistDeviceAccess(data as RestrictedDeviceAccess);
    return data as RestrictedDeviceAccess;
  }
}

export default new DeviceAccessService();
