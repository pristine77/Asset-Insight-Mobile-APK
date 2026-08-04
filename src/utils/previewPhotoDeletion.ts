export type LotPhotoReference = {
  globalIndex: number | null;
  url: string;
};

type PhotoDeletionState = {
  deleted_image_indexes?: number[];
  deleted_image_urls?: string[];
};

export const removeLotPhotoReference = <T>(
  previewData: T,
  lotIndex: number,
  photo: LotPhotoReference
): T & PhotoDeletionState => {
  if (!previewData || typeof previewData !== "object") {
    return previewData as T & PhotoDeletionState;
  }
  const data = previewData as any;
  if (!Array.isArray(data.lots) || !data.lots[lotIndex]) {
    return previewData as T & PhotoDeletionState;
  }

  const { globalIndex, url: imageUrl } = photo;
  const hasGlobalIndex =
    Number.isInteger(globalIndex) && Number(globalIndex) >= 0;
  const lots = [...data.lots];
  const lot = { ...lots[lotIndex] };
  const removeIndex = (values: unknown) =>
    hasGlobalIndex && Array.isArray(values)
      ? values.filter((value) => Number(value) !== globalIndex)
      : values;

  lot.image_indexes = removeIndex(lot.image_indexes);
  lot.extra_image_indexes = removeIndex(lot.extra_image_indexes);
  if (hasGlobalIndex && Number(lot.image_index) === globalIndex) {
    delete lot.image_index;
  }
  if (hasGlobalIndex && Number(lot.cover_index) === globalIndex) {
    delete lot.cover_index;
  }
  if (imageUrl) {
    if (Array.isArray(lot.image_urls)) {
      lot.image_urls = lot.image_urls.filter((url: unknown) => url !== imageUrl);
    }
    if (Array.isArray(lot.extra_image_urls)) {
      lot.extra_image_urls = lot.extra_image_urls.filter(
        (url: unknown) => url !== imageUrl
      );
    }
    if (lot.image_url === imageUrl) delete lot.image_url;
    if (lot.cover_url === imageUrl) delete lot.cover_url;
  }
  lots[lotIndex] = lot;

  const stillReferenced = lots.some((candidate: any) => {
    const indexRefs = [
      ...(Array.isArray(candidate?.image_indexes) ? candidate.image_indexes : []),
      ...(Array.isArray(candidate?.extra_image_indexes)
        ? candidate.extra_image_indexes
        : []),
      ...(candidate?.image_index !== undefined ? [candidate.image_index] : []),
      ...(candidate?.cover_index !== undefined ? [candidate.cover_index] : []),
    ];
    const urlRefs = [
      ...(Array.isArray(candidate?.image_urls) ? candidate.image_urls : []),
      ...(Array.isArray(candidate?.extra_image_urls)
        ? candidate.extra_image_urls
        : []),
      candidate?.image_url,
      candidate?.cover_url,
    ].filter(Boolean);
    return (
      (hasGlobalIndex &&
        indexRefs.some((value) => Number(value) === globalIndex)) ||
      urlRefs.some((value) => value === imageUrl)
    );
  });

  const deletedIndexes = Array.isArray(data.deleted_image_indexes)
    ? data.deleted_image_indexes
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isInteger(value) && value >= 0)
    : [];
  const nextDeletedIndexes =
    !hasGlobalIndex ||
    stillReferenced ||
    deletedIndexes.includes(Number(globalIndex))
      ? deletedIndexes
      : [...deletedIndexes, Number(globalIndex)];
  const deletedUrls = Array.isArray(data.deleted_image_urls)
    ? data.deleted_image_urls.filter(
        (value: unknown): value is string => typeof value === "string"
      )
    : [];
  const nextDeletedUrls =
    stillReferenced || !imageUrl || deletedUrls.includes(imageUrl)
      ? deletedUrls
      : [...deletedUrls, imageUrl];

  return {
    ...data,
    lots,
    deleted_image_indexes: nextDeletedIndexes,
    deleted_image_urls: nextDeletedUrls,
  } as T & PhotoDeletionState;
};

export const removeGalleryPhotoEntry = <
  T extends LotPhotoReference & { lotIndex: number | null },
>(
  entries: T[],
  currentIdx: number,
  target: LotPhotoReference & { lotIndex: number }
) => {
  const nextEntries = entries.filter(
    (entry) =>
      !(
        entry.lotIndex === target.lotIndex &&
        entry.url === target.url &&
        entry.globalIndex === target.globalIndex
      )
  );
  return {
    entries: nextEntries,
    currentIdx: nextEntries.length
      ? Math.min(currentIdx, nextEntries.length - 1)
      : 0,
  };
};
