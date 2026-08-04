import api from './api';
import { isRetryableRequestError } from './connectivityService';

const FileSystem = require('expo-file-system/legacy');

export type DirectUploadFile = {
  uri: string;
  name: string;
  type: string;
  size?: number;
  fieldname?: 'images' | 'videos';
  lotIndex?: number;
  imageIndex?: number;
  captureOrder?: number;
  originalOrder?: number;
  role?: 'main' | 'extra' | 'video';
};

export type DirectUploadSessionResponse = {
  sessionId: string;
  reportId?: string;
  jobId: string;
  status?: string;
  resumed?: boolean;
  alreadyQueued?: boolean;
  processed?: boolean;
  readyToComplete?: boolean;
  files: Array<{
    fileId: string;
    key: string;
    uploadUrl: string;
    method: 'PUT';
    contentType: string;
  }>;
};

const DIRECT_UPLOAD_CONCURRENCY = 4;
const DIRECT_UPLOAD_RETRIES = 2;
const DIRECT_UPLOAD_SESSION_REFRESH_RETRIES = 1;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUploadError(error: unknown, fallbackMessage: string): Error {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' && error.trim() ? error : fallbackMessage);
  // Only transport failures and transient HTTP responses are recoverable.
  // Marking a 400/403/413 response as "network" used to send online reports
  // into the offline queue and hide the actionable server response.
  if (isRetryableRequestError(err)) {
    (err as any).isRecoverableUploadError = true;
    (err as any).code = (err as any).code || 'ERR_NETWORK';
  }
  if (!err.message) err.message = fallbackMessage;
  return err;
}

type R2UploadError = Error & { status?: number; responseBody?: string };

function makeR2UploadError(file: DirectUploadFile, status?: number, responseBody?: string): R2UploadError {
  const detail = responseBody?.trim().replace(/\s+/g, " ").slice(0, 180);
  const error = new Error(
    `R2 upload failed for ${file.name}${status ? ` (${status})` : ""}${detail ? `: ${detail}` : ""}`
  ) as R2UploadError;
  error.status = status;
  error.responseBody = responseBody;
  return error;
}

async function uploadOneWithFileSystem(
  file: DirectUploadFile,
  uploadUrl: string,
  contentType: string,
  onFileProgress?: (sentBytes: number, totalBytes?: number) => void
) {
  const headers = {
    'Content-Type': contentType || file.type || 'application/octet-stream',
  };
  const uploadType = FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 'BINARY_CONTENT';

  if (typeof FileSystem.createUploadTask === 'function') {
    const task = FileSystem.createUploadTask(
      uploadUrl,
      file.uri,
      {
        httpMethod: 'PUT',
        uploadType,
        headers,
      },
      (progress: any) => {
        const sent = Number(progress?.totalBytesSent || 0);
        const expected = Number(progress?.totalBytesExpectedToSend || file.size || 0) || undefined;
        onFileProgress?.(sent, expected);
      }
    );
    const result = await task.uploadAsync();
    const status = Number(result?.status || 0);
    if (status < 200 || status >= 300) {
      throw makeR2UploadError(file, status, String((result as any)?.body || ""));
    }
    return;
  }

  if (typeof FileSystem.uploadAsync === 'function') {
    const result = await FileSystem.uploadAsync(uploadUrl, file.uri, {
      httpMethod: 'PUT',
      uploadType,
      headers,
    });
    const status = Number(result?.status || 0);
    if (status < 200 || status >= 300) {
      throw makeR2UploadError(file, status, String((result as any)?.body || ""));
    }
    onFileProgress?.(file.size || 1, file.size);
    return;
  }

  throw new Error('Filesystem upload is not available');
}

async function uploadOne(file: DirectUploadFile, uploadUrl: string, contentType: string) {
  try {
    await uploadOneWithFileSystem(file, uploadUrl, contentType);
    return;
  } catch (error: any) {
    // A signed R2 response is authoritative. Do not hide a 4xx/5xx failure by
    // attempting a second transport with the same invalid URL.
    if (Number(error?.status || 0) > 0) throw error;
    console.warn('[DirectR2Upload] Filesystem upload failed, using fetch fallback:', error);
  }

  const source = await fetch(file.uri);
  const blob = await source.blob();
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType || file.type || 'application/octet-stream',
    },
    body: blob,
  });
  if (!response.ok) {
    throw makeR2UploadError(file, response.status, await response.text().catch(() => ""));
  }
}

async function uploadOneWithRetry(file: DirectUploadFile, uploadUrl: string, contentType: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DIRECT_UPLOAD_RETRIES; attempt++) {
    try {
      await uploadOne(file, uploadUrl, contentType);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRequestError(error)) break;
      if (attempt < DIRECT_UPLOAD_RETRIES) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw normalizeUploadError(lastError, `Upload failed for ${file.name}`);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) break;
        await worker(items[index], index);
      }
    })
  );
}

function buildManifest(files: DirectUploadFile[]) {
  return files.map((file, index) => ({
    fileId: `${file.fieldname || 'images'}-${index}`,
    name: file.name || `${file.fieldname || 'image'}-${index + 1}`,
    type: file.type || 'application/octet-stream',
    size: file.size,
    fieldname: file.fieldname || 'images',
    lotIndex: file.lotIndex,
    imageIndex: file.imageIndex ?? index,
    captureOrder: file.captureOrder ?? file.originalOrder ?? index,
    originalOrder: index,
    role: file.role || (file.fieldname === 'videos' ? 'video' : 'main'),
  }));
}

async function createOrResumeUploadSession(
  endpoint: '/asset' | '/lot-listing',
  details: Record<string, any>,
  manifest: ReturnType<typeof buildManifest>
) {
  const response = await api.post<{ data: DirectUploadSessionResponse }>(
    `${endpoint}/upload-session`,
    { details, files: manifest },
    { timeout: 60000 }
  );
  return response.data.data;
}

async function uploadOneThroughServerFallback(
  endpoint: '/asset' | '/lot-listing',
  sessionId: string,
  fileId: string,
  file: DirectUploadFile
) {
  const formData = new FormData();
  formData.append('file', {
    uri: file.uri,
    name: file.name || 'upload.jpg',
    type: file.type || 'application/octet-stream',
  } as any);
  await api.post(
    `${endpoint}/upload-session/${sessionId}/files/${encodeURIComponent(fileId)}`,
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    }
  );
}

export async function uploadReportFilesDirectToR2(args: {
  endpoint: '/asset' | '/lot-listing';
  details: Record<string, any>;
  files: DirectUploadFile[];
  onProgress?: (progress: number) => void;
}): Promise<{ jobId: string; reportId: string; message: string; phase?: string; status?: string }> {
  const totalBytes = args.files.reduce((sum, file) => sum + (file.size || 1), 0) || args.files.length || 1;
  let uploadedBytes = 0;

  const manifest = buildManifest(args.files);
  let session = await createOrResumeUploadSession(args.endpoint, args.details, manifest);
  if (session.alreadyQueued && session.reportId) {
    args.onProgress?.(100);
    return {
      jobId: session.jobId,
      reportId: session.reportId,
      message: "Submission already accepted and is being processed.",
      phase: session.processed || session.status === "processed" ? "done" : "processing",
      status: session.status || "processing",
    };
  }
  let uploadById = new Map(session.files.map((file) => [file.fileId, file]));

  if (!session.readyToComplete) {
    const pendingIndexes = args.files.map((_, index) => index);
    for (let refreshAttempt = 0; refreshAttempt <= DIRECT_UPLOAD_SESSION_REFRESH_RETRIES; refreshAttempt += 1) {
      const failures: Array<{ index: number; error: unknown }> = [];
      await mapWithConcurrency(pendingIndexes, DIRECT_UPLOAD_CONCURRENCY, async (index) => {
        const file = args.files[index];
        const descriptor = manifest[index];
        const target = uploadById.get(descriptor.fileId);
        if (!target) throw new Error(`Missing upload target for ${file.name}`);
        try {
          await uploadOneWithRetry(file, target.uploadUrl, target.contentType);
          uploadedBytes += file.size || 1;
          args.onProgress?.(Math.max(0, Math.min(100, Math.round((uploadedBytes / totalBytes) * 90))));
        } catch (error) {
          failures.push({ index, error });
        }
      });

      if (!failures.length) break;
      if (refreshAttempt >= DIRECT_UPLOAD_SESSION_REFRESH_RETRIES) {
        // Direct R2 uploads can be blocked by a device VPN, carrier, or R2
        // network policy. Fall back per file through the authenticated API,
        // retaining this exact session and manifest.
        const fallbackFailures: Array<{ index: number; error: unknown }> = [];
        await mapWithConcurrency(failures, Math.min(2, DIRECT_UPLOAD_CONCURRENCY), async (failure) => {
          const file = args.files[failure.index];
          const descriptor = manifest[failure.index];
          try {
            await uploadOneThroughServerFallback(args.endpoint, session.sessionId, descriptor.fileId, file);
            uploadedBytes += file.size || 1;
            args.onProgress?.(Math.max(0, Math.min(100, Math.round((uploadedBytes / totalBytes) * 90))));
          } catch (error) {
            fallbackFailures.push({ index: failure.index, error });
          }
        });
        if (fallbackFailures.length) {
          throw normalizeUploadError(
            fallbackFailures[0].error,
            `Upload failed for ${args.files[fallbackFailures[0].index].name}`
          );
        }
        break;
      }

      // Reusing the same manifest and client submission id returns the same
      // session with fresh signed targets. Completed files are left untouched.
      session = await createOrResumeUploadSession(args.endpoint, args.details, manifest);
      uploadById = new Map(session.files.map((file) => [file.fileId, file]));
      pendingIndexes.splice(0, pendingIndexes.length, ...failures.map((failure) => failure.index));
    }
  }

  args.onProgress?.(95);
  const completeResponse = await api.post(
    `${args.endpoint}/upload-session/${session.sessionId}/complete`,
    {},
    { timeout: 60000 }
  );
  args.onProgress?.(100);
  return completeResponse.data;
}
