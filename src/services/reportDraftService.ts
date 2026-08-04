import api from './api';
import type {
  AutoSaveFormData,
  OfflineDraftType,
  OfflineReportDraft,
  SavedLotData,
} from './autoSaveService';

export type CloudDraftMedia = {
  localKey?: string;
  lotId?: string;
  slot?: string;
  index?: number;
  name?: string;
  url?: string;
  mimeType?: string;
  size?: number;
};

export type ReportDraft = {
  _id?: string;
  id: string;
  clientDraftId?: string;
  type: OfflineDraftType;
  contractNo: string;
  normalizedContractNo: string;
  title: string;
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  media?: CloudDraftMedia[];
  createdAt: string;
  updatedAt: string;
};

const normalizeContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const mediaFromDraft = (draft: OfflineReportDraft): CloudDraftMedia[] => {
  const media: CloudDraftMedia[] = [];

  draft.lots.forEach((lot, lotIndex) => {
    lot.mainImages.forEach((image, index) => {
      const data = typeof image === 'string' ? { uri: image, name: `main-${index}.jpg`, type: 'image/jpeg' } : image;
      media.push({
        localKey: `${draft.id}:${lot.id}:main:${index}`,
        lotId: lot.id,
        slot: 'main',
        index,
        name: data.name,
        url: data.uri,
        mimeType: data.type,
      });
    });

    lot.extraImages.forEach((image, index) => {
      const data = typeof image === 'string' ? { uri: image, name: `extra-${index}.jpg`, type: 'image/jpeg' } : image;
      media.push({
        localKey: `${draft.id}:${lot.id}:extra:${index}`,
        lotId: lot.id,
        slot: 'extra',
        index,
        name: data.name,
        url: data.uri,
        mimeType: data.type,
      });
    });

    (lot.videoFiles || []).forEach((video, index) => {
      const data = typeof video === 'string' ? { uri: video, name: `video-${lotIndex}-${index}.mp4`, type: 'video/mp4' } : video;
      media.push({
        localKey: `${draft.id}:${lot.id}:video:${index}`,
        lotId: lot.id,
        slot: 'video',
        index,
        name: data.name,
        url: data.uri,
        mimeType: data.type,
      });
    });
  });

  return media;
};

const isUploadableLocalUri = (uri?: string) =>
  Boolean(uri && !/^https?:\/\//i.test(uri));

const uploadableMediaFromDraft = (draft: OfflineReportDraft) => {
  const files: Array<{ uri: string; name: string; type: string }> = [];
  const metadata: CloudDraftMedia[] = [];

  const add = (
    value: any,
    lotId: string,
    slot: 'main' | 'extra' | 'video',
    index: number,
    fallbackName: string,
    fallbackType: string
  ) => {
    const data = typeof value === 'string'
      ? { uri: value, name: fallbackName, type: fallbackType }
      : {
          uri: value?.displayUri || value?.editedUri || value?.uri || value?.originalUri,
          name: value?.name || fallbackName,
          type: value?.type || fallbackType,
        };

    if (!isUploadableLocalUri(data.uri)) return;

    files.push(data);
    metadata.push({
      localKey: `${draft.id}:${lotId}:${slot}:${index}`,
      lotId,
      slot,
      index,
      name: data.name,
      mimeType: data.type,
    });
  };

  draft.lots.forEach((lot, lotIndex) => {
    lot.mainImages.forEach((image, index) =>
      add(image, lot.id, 'main', index, `main-${lotIndex}-${index}.jpg`, 'image/jpeg')
    );
    lot.extraImages.forEach((image, index) =>
      add(image, lot.id, 'extra', index, `extra-${lotIndex}-${index}.jpg`, 'image/jpeg')
    );
    (lot.videoFiles || []).forEach((video, index) =>
      add(video, lot.id, 'video', index, `video-${lotIndex}-${index}.mp4`, 'video/mp4')
    );
  });

  return { files, metadata };
};

const reportDraftService = {
  async list(): Promise<ReportDraft[]> {
    const response = await api.get<{ message: string; data: ReportDraft[] }>('/report-drafts');
    return response.data.data || [];
  },

  async upsertFromLocalDraft(draft: OfflineReportDraft): Promise<ReportDraft> {
    const response = await api.post<{ message: string; data: ReportDraft }>('/report-drafts', {
      clientDraftId: draft.id,
      type: draft.type,
      contractNo: draft.contractNo || draft.formData.contractNo,
      normalizedContractNo: draft.normalizedContractNo || normalizeContractNo(draft.contractNo || draft.formData.contractNo),
      title: draft.title,
      formData: draft.formData,
      lots: draft.lots,
      activeLotIdx: draft.activeLotIdx,
      media: mediaFromDraft(draft),
    });
    const cloud = response.data.data;
    const uploadable = uploadableMediaFromDraft(draft);
    if ((cloud.id || cloud._id) && uploadable.files.length > 0) {
      const formData = new FormData();
      formData.append('replace', 'true');
      formData.append('metadata', JSON.stringify(uploadable.metadata));
      for (const file of uploadable.files) {
        formData.append('files', file as any);
      }

      const uploadResponse = await api.post<{ message: string; data: CloudDraftMedia[] }>(
        `/report-drafts/${cloud.id || cloud._id}/media`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 300000,
        }
      );
      cloud.media = uploadResponse.data.data;
    }
    return cloud;
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/report-drafts/${id}`);
  },
};

export default reportDraftService;
