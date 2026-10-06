type NativeAuctionCameraModule = {
  openAuctionCamera: (initialPayload?: string) => Promise<string>;
  getContentUriInfo?: (uri: string) => Promise<{ exists: boolean; size?: number; type?: string }>;
  getPendingCapture?: (ownerId: string, draftId: string) => Promise<string | null>;
  acknowledgeCapture?: (ownerId: string, draftId: string, sessionId: string, revision: number) => Promise<boolean>;
  streamContentUriUpload?: (args: { id: string; uri: string; url: string; headers: Record<string, string>; size: number; onProgress?: (bytesSent: number, totalBytes: number) => void }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
  cancelContentUriUpload?: (id: string) => Promise<void>;
};

// Keep native-module resolution deferred until an unlocked Android capture opens.
export async function loadNativeAuctionCamera(): Promise<NativeAuctionCameraModule> {
  const module = (await import('../../../modules/auction-camera')) as NativeAuctionCameraModule;
  if (typeof module.openAuctionCamera !== 'function') {
    throw new Error('Native auction camera module is not available.');
  }
  return module;
}
