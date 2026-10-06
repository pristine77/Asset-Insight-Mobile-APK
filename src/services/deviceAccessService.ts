import api from "./api";
import authService, { type LoginResponse } from "./authService";
import {
  getDeviceKey,
  getPersistedDeviceAccess,
  persistDeviceAccess,
  type RestrictedDeviceAccess,
} from "./deviceAccessStorage";
import { collectVerifiedNativeDeviceContext } from "./deviceMetadataService";
import { captureAuthOperation, mutateAuthSession } from './authSessionOperation';

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
  async register(assertCurrent = captureAuthOperation()) {
    const context = await collectVerifiedNativeDeviceContext();
    assertCurrent();
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
    assertCurrent();
    if (data?.authState !== 'approved') await mutateAuthSession(assertCurrent, () => persistDeviceAccess(data as RestrictedDeviceAccess, assertCurrent));
    return data as RestrictedDeviceAccess & { authState?: string };
  }

  async status(assertCurrent = captureAuthOperation()) {
    const current = await getPersistedDeviceAccess();
    const { data } = await api.get("/auth/device-requests/status", {
      headers: await headers(),
    });
    const status = String(data?.status || data?.authState || "");
    assertCurrent();
    if (status && status !== "approved") {
      const next = {
        ...current,
        ...data,
        authState: status,
        challengeToken: data?.challengeToken || current?.challengeToken,
        challengeExpiresAt: data?.challengeExpiresAt || current?.challengeExpiresAt,
      } as RestrictedDeviceAccess;
      await mutateAuthSession(assertCurrent, () => persistDeviceAccess(next, assertCurrent));
      return next;
    }
    return data as RestrictedDeviceAccess & { status?: string };
  }

  async exchange(assertCurrent = captureAuthOperation()) {
    const { data } = await api.post(
      "/auth/device-requests/exchange",
      {},
      { headers: await headers() }
    );
    assertCurrent();
    return authService.acceptAuthenticatedResponse(data as LoginResponse, assertCurrent);
  }

  async rerequest(assertCurrent = captureAuthOperation()) {
    const context = await collectVerifiedNativeDeviceContext();
    assertCurrent();
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
    assertCurrent();
    await mutateAuthSession(assertCurrent, () => persistDeviceAccess(data as RestrictedDeviceAccess, assertCurrent));
    return data as RestrictedDeviceAccess;
  }
}

export default new DeviceAccessService();
