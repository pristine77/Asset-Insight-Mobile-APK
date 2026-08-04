import { requireNativeModule } from 'expo-modules-core';

// This resolves to the AuctionCameraModule registered via Name("AuctionCameraModule") in Kotlin
const AuctionCamera = requireNativeModule('AuctionCameraModule');

/**
 * Opens the native Auction Camera activity.
 * @param initialPayload Optional JSON string of existing lots to seed the camera session.
 * @returns A promise that resolves with the lot payload JSON string,
 *          or rejects with E_CANCELLED if the user presses Back without capturing.
 */
export async function openAuctionCamera(initialPayload?: string): Promise<string> {
  return AuctionCamera.openAuctionCamera(initialPayload ?? '');
}
