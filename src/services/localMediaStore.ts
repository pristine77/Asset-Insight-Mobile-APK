import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

type ImportMediaArgs = {
  draftId: string;
  lotId: string;
  slot: 'main' | 'extra' | 'video';
  index: number;
  sourceUri: string;
  name?: string;
  type?: string;
  mediaId?: string;
};

export type StoredMedia = {
  mediaId: string;
  uri: string;
  thumbnailUri?: string;
  name: string;
  type: string;
  size?: number;
  sourceUri: string;
  createdAt: string;
};

const MEDIA_ROOT = `${FileSystem.documentDirectory || ''}local_media_store/`;
const DRAFT_ROOT = `${MEDIA_ROOT}drafts/`;
const nativeCameraDirs = () =>
  FileSystem.cacheDirectory
    ? [`${FileSystem.cacheDirectory}lot_photos/`, `${FileSystem.cacheDirectory}lot_videos/`]
    : [];
const THUMBNAIL_DIR_NAME = 'thumbs';
const MAX_FILE_OP_CONCURRENCY = 4;
const ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const ensureDirectory = async (dir: string): Promise<void> => {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
};

const fileExists = async (uri?: string | null): Promise<boolean> => {
  if (!uri) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists);
  } catch {
    return false;
  }
};

const getFileInfo = async (uri: string): Promise<{ exists: boolean; size?: number; modificationTime?: number }> => {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return {
      exists: Boolean(info.exists),
      size: info.exists && typeof info.size === 'number' ? info.size : undefined,
      modificationTime: info.exists && typeof info.modificationTime === 'number' ? info.modificationTime : undefined,
    };
  } catch {
    return { exists: false };
  }
};

const getExtension = (nameOrUri?: string, fallback = 'jpg') => {
  const match = /\.([a-zA-Z0-9]+)(\?|#|$)/.exec(nameOrUri || '');
  return match?.[1]?.toLowerCase() || fallback;
};

const safeNamePart = (value?: string | null) =>
  String(value || 'media')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'media';

const makeMediaId = () =>
  `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeSourceUri = (uri: string) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri;
  return `file://${uri}`;
};

const uriScheme = (uri: string) => {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri);
  return match?.[1]?.toLowerCase();
};

const isImage = (type?: string, uri?: string) => {
  const lowerType = String(type || '').toLowerCase();
  if (lowerType.startsWith('image/')) return true;
  const ext = getExtension(uri || '', '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);
};

const runWithConcurrency = async <T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency = MAX_FILE_OP_CONCURRENCY
) => {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) break;
        await worker(items[index]);
      }
    })
  );
};

const collectFiles = async (dir: string): Promise<string[]> => {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) return [];

  const entries = await FileSystem.readDirectoryAsync(dir);
  const output: string[] = [];
  for (const entry of entries) {
    const child = `${dir}${entry}`;
    const childInfo = await FileSystem.getInfoAsync(child);
    if (childInfo.exists && childInfo.isDirectory) {
      output.push(...(await collectFiles(`${child}/`)));
    } else if (childInfo.exists) {
      output.push(child);
    }
  }
  return output;
};

const deleteIfExists = async (uri?: string | null): Promise<void> => {
  if (!uri) return;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // best-effort cleanup
  }
};

export const LocalMediaStore = {
  mediaRoot: MEDIA_ROOT,

  getDraftDir(draftId: string) {
    return `${DRAFT_ROOT}${safeNamePart(draftId)}/`;
  },

  getDraftThumbDir(draftId: string) {
    return `${this.getDraftDir(draftId)}${THUMBNAIL_DIR_NAME}/`;
  },

  isManagedUri(uri?: string | null) {
    return Boolean(uri && uri.startsWith(MEDIA_ROOT));
  },

  async importMedia(args: ImportMediaArgs): Promise<StoredMedia | null> {
    const sourceUri = normalizeSourceUri(args.sourceUri);
    const sourceInfo = await getFileInfo(sourceUri);
    const scheme = uriScheme(sourceUri);
    const canTryContentCopy = scheme === 'content';
    if (!sourceInfo.exists && !canTryContentCopy) {
      console.warn(`[LocalMediaStore] Source file does not exist: ${args.sourceUri}`);
      return null;
    }

    const draftDir = this.getDraftDir(args.draftId);
    await ensureDirectory(draftDir);

    const mediaId = args.mediaId || makeMediaId();
    const ext = getExtension(args.name || sourceUri, args.slot === 'video' ? 'mp4' : 'jpg');
    const fileName = `${safeNamePart(args.lotId)}_${args.slot}_${String(args.index).padStart(4, '0')}_${safeNamePart(mediaId)}.${ext}`;
    const destinationUri = `${draftDir}${fileName}`;

    if (sourceUri !== destinationUri && !(await fileExists(destinationUri))) {
      try {
        await FileSystem.copyAsync({ from: sourceUri, to: destinationUri });
      } catch (error) {
        console.warn(`[LocalMediaStore] Failed to import media: ${sourceUri}`, error);
        return null;
      }
    }

    const copiedInfo = await getFileInfo(destinationUri);
    if (!copiedInfo.exists) {
      console.warn(`[LocalMediaStore] Imported media is missing after copy: ${destinationUri}`);
      return null;
    }

    let thumbnailUri: string | undefined;
    if (isImage(args.type, sourceUri)) {
      try {
        const thumbDir = this.getDraftThumbDir(args.draftId);
        await ensureDirectory(thumbDir);
        const thumbName = `${safeNamePart(args.lotId)}_${args.slot}_${String(args.index).padStart(4, '0')}_${safeNamePart(mediaId)}.jpg`;
        const thumbTarget = `${thumbDir}${thumbName}`;
        if (!(await fileExists(thumbTarget))) {
          const result = await ImageManipulator.manipulateAsync(
            destinationUri,
            [{ resize: { width: 260 } }],
            { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG }
          );
          await FileSystem.copyAsync({ from: result.uri, to: thumbTarget });
          await deleteIfExists(result.uri);
        }
        thumbnailUri = thumbTarget;
      } catch (error) {
        console.warn('[LocalMediaStore] Thumbnail generation failed:', error);
      }
    }

    return {
      mediaId,
      uri: destinationUri,
      thumbnailUri,
      name: args.name || fileName,
      type: args.type || (args.slot === 'video' ? 'video/mp4' : 'image/jpeg'),
      size: copiedInfo.size ?? sourceInfo.size,
      sourceUri,
      createdAt: new Date().toISOString(),
    };
  },

  async deleteDraftMedia(draftId: string): Promise<void> {
    await deleteIfExists(this.getDraftDir(draftId));
  },

  async pruneDraftFiles(draftId: string, keepUris: Iterable<string | undefined | null>): Promise<void> {
    const draftDir = this.getDraftDir(draftId);
    const keep = new Set(
      Array.from(keepUris)
        .filter(Boolean)
        .map((uri) => String(uri))
        .filter((uri) => uri.startsWith(draftDir))
    );
    const allFiles = await collectFiles(draftDir);
    const stale = allFiles.filter((uri) => !keep.has(uri));
    await runWithConcurrency(stale, deleteIfExists);
  },

  async getDirectorySize(uri: string): Promise<number> {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return 0;
    if (!info.isDirectory) return typeof info.size === 'number' ? info.size : 0;
    const files = await collectFiles(uri.endsWith('/') ? uri : `${uri}/`);
    let total = 0;
    for (const file of files) {
      const fileInfo = await getFileInfo(file);
      total += fileInfo.size || 0;
    }
    return total;
  },

  async cleanupOrphanedDraftFolders(activeDraftIds: string[], activeFileUris: string[] = []): Promise<number> {
    const rootInfo = await FileSystem.getInfoAsync(DRAFT_ROOT);
    if (!rootInfo.exists) return 0;

    const activeDirs = new Set(activeDraftIds.map((id) => this.getDraftDir(id)));
    const activeFiles = new Set(activeFileUris.filter(Boolean));
    const now = Date.now();
    let deletedBytes = 0;
    const entries = await FileSystem.readDirectoryAsync(DRAFT_ROOT);

    for (const entry of entries) {
      const dir = `${DRAFT_ROOT}${entry}/`;
      if (activeDirs.has(dir)) continue;

      const files = await collectFiles(dir);
      if (files.some((uri) => activeFiles.has(uri))) continue;
      const newest = Math.max(
        0,
        ...(await Promise.all(files.map(async (uri) => (await getFileInfo(uri)).modificationTime || 0)))
      );
      if (newest && now - newest * 1000 < ORPHAN_MAX_AGE_MS) continue;

      deletedBytes += await this.getDirectorySize(dir);
      await deleteIfExists(dir);
    }

    return deletedBytes;
  },

  async cleanupNativeCameraCache(activeFileUris: string[] = [], maxAgeMs = ORPHAN_MAX_AGE_MS): Promise<number> {
    const active = new Set(activeFileUris.filter(Boolean));
    const now = Date.now();
    let deletedBytes = 0;

    for (const dir of nativeCameraDirs()) {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) continue;
      const files = await collectFiles(dir);
      for (const file of files) {
        if (active.has(file)) continue;
        const fileInfo = await getFileInfo(file);
        const modifiedMs = fileInfo.modificationTime ? fileInfo.modificationTime * 1000 : 0;
        if (maxAgeMs > 0 && modifiedMs && now - modifiedMs < maxAgeMs) continue;
        deletedBytes += fileInfo.size || 0;
        await deleteIfExists(file);
      }
    }

    return deletedBytes;
  },
};

export default LocalMediaStore;
