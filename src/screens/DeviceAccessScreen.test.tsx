import React from "react";
import { AppState } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import DeviceAccessScreen, { APPROVAL_CHECK_INTERVAL_MS } from "./DeviceAccessScreen";
import { useAuth } from "../context/AuthContext";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));
jest.mock("../services/deviceMetadataService", () => ({
  buildNativeDeviceContext: jest.fn(() => new Promise(() => undefined)),
  NativeCameraVerificationError: class NativeCameraVerificationError extends Error {},
}));

const base = {
  user: null,
  loading: false,
  isAuthenticated: false,
  login: jest.fn(),
  registerDevice: jest.fn(),
  refreshDeviceStatus: jest.fn(),
  rerequestDevice: jest.fn(),
  logout: jest.fn(),
  refreshUser: jest.fn(),
  error: null,
  clearError: jest.fn(),
};

describe("DeviceAccessScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the native pending state and manual status action", async () => {
    jest.mocked(useAuth).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "pending",
        challengeToken: "challenge",
        device: { id: "device-1", status: "pending", displayName: "Android tablet" },
      },
    });

    await render(<DeviceAccessScreen />);

    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByText("Check status")).toBeTruthy();
  });

  describe("waiting for approval (opens the app as soon as the phone is approved)", () => {
    const pending = {
      authState: "pending" as const,
      challengeToken: "challenge",
      device: { id: "device-1", status: "pending", displayName: "Android phone" },
    };
    let appStateListener: ((state: string) => void) | undefined;

    beforeEach(() => {
      jest.useFakeTimers();
      appStateListener = undefined;
      jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener: any) => {
        appStateListener = listener;
        return { remove: jest.fn() } as any;
      });
      Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("checks straight away, then every few seconds", async () => {
      const refreshDeviceStatus = jest.fn().mockResolvedValue(undefined);
      jest.mocked(useAuth).mockReturnValue({ ...base, refreshDeviceStatus, deviceAccess: pending });

      await render(<DeviceAccessScreen />);
      expect(refreshDeviceStatus).toHaveBeenCalledTimes(1);

      await act(async () => { jest.advanceTimersByTime(APPROVAL_CHECK_INTERVAL_MS); });
      expect(refreshDeviceStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("We check every few seconds and open the app as soon as this phone is approved.")).toBeTruthy();
    });

    it("checks again the moment the app comes back to the front", async () => {
      const refreshDeviceStatus = jest.fn().mockResolvedValue(undefined);
      jest.mocked(useAuth).mockReturnValue({ ...base, refreshDeviceStatus, deviceAccess: pending });

      await render(<DeviceAccessScreen />);
      expect(refreshDeviceStatus).toHaveBeenCalledTimes(1);

      await act(async () => { appStateListener?.("active"); });
      expect(refreshDeviceStatus).toHaveBeenCalledTimes(2);
    });

    it("does not re-check immediately just because a check stored a fresh pending state", async () => {
      const refreshDeviceStatus = jest.fn().mockResolvedValue(undefined);
      jest.mocked(useAuth).mockReturnValue({ ...base, refreshDeviceStatus, deviceAccess: pending });

      const rendered = await render(<DeviceAccessScreen />);
      jest.mocked(useAuth).mockReturnValue({ ...base, refreshDeviceStatus, deviceAccess: { ...pending } });
      await rendered.rerender(<DeviceAccessScreen />);
      expect(refreshDeviceStatus).toHaveBeenCalledTimes(1);
    });

    it("does not check while the app is in the background", async () => {
      Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
      const refreshDeviceStatus = jest.fn().mockResolvedValue(undefined);
      jest.mocked(useAuth).mockReturnValue({ ...base, refreshDeviceStatus, deviceAccess: pending });

      await render(<DeviceAccessScreen />);
      await act(async () => { jest.advanceTimersByTime(APPROVAL_CHECK_INTERVAL_MS * 3); });
      expect(refreshDeviceStatus).not.toHaveBeenCalled();
    });
  });

  it("shows support but no re-request action for a blocked IP", async () => {
    jest.mocked(useAuth).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "ip_blocked",
        supportContact: {
          name: "Security team",
          email: "security@example.test",
          phone: "+44 20 7946 0000",
        },
      },
    });

    await render(<DeviceAccessScreen />);

    expect(screen.getByText("IP address blocked")).toBeTruthy();
    expect(screen.getByText("security@example.test")).toBeTruthy();
    expect(screen.queryByText("Request again")).toBeNull();
  });

  it("uses the polished primary action for a rejected device and submits a re-request", async () => {
    const rerequestDevice = jest.fn().mockResolvedValue(undefined);
    jest.mocked(useAuth).mockReturnValue({
      ...base,
      rerequestDevice,
      deviceAccess: {
        authState: "rejected",
        reason: "Confirm this managed phone.",
        device: { id: "device-2", status: "rejected", displayName: "Samsung Galaxy S22+" },
      },
    });

    const rendered = await render(<DeviceAccessScreen />);
    const action = rendered.getByRole("button", { name: "Request again" });
    expect(action.props.accessibilityState).toMatchObject({ disabled: false, busy: false });
    fireEvent.press(action);
    expect(rerequestDevice).toHaveBeenCalledTimes(1);
  });
});
