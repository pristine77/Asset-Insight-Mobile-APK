import api from './api';

// Types
export interface SalvageDetails {
  report_date: string;
  file_number: string;
  date_received: string;
  claim_number: string;
  policy_number: string;
  appraiser_name: string;
  appraiser_phone: string;
  appraiser_email: string;
  adjuster_name: string;
  insured_name: string;
  company_name: string;
  company_address: string;
  appraiser_comments: string;
  next_report_due: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string;
}

export interface SalvageCreateResponse {
  message: string;
  jobId?: string;
  phase?: 'upload' | 'processing' | 'done' | 'error';
}

export interface ProgressData {
  id: string;
  phase: 'upload' | 'processing' | 'done' | 'error';
  serverProgress01: number;
  steps: Array<{
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  message?: string;
}

// Helper to create FormData for images
const createFormData = (
  details: SalvageDetails,
  images: Array<{ uri: string; name: string; type: string }>
): FormData => {
  const formData = new FormData();
  formData.append('details', JSON.stringify(details));

  images.forEach((image, index) => {
    formData.append('images', {
      uri: image.uri,
      name: image.name || `image_${index}.jpg`,
      type: image.type || 'image/jpeg',
    } as any);
  });

  return formData;
};

const salvageService = {
  /**
   * Create a new salvage report
   */
  async create(
    details: SalvageDetails,
    images: Array<{ uri: string; name: string; type: string }>,
    onUploadProgress?: (progress: number) => void
  ): Promise<SalvageCreateResponse> {
    const formData = createFormData(details, images);

    const response = await api.post<SalvageCreateResponse>('/salvage', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onUploadProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onUploadProgress(progress);
        }
      },
    });

    return response.data;
  },

  /**
   * Get progress of a salvage report job
   */
  async getProgress(jobId: string): Promise<ProgressData> {
    const response = await api.get<ProgressData>(`/salvage/progress/${jobId}`);
    return response.data;
  },
};

export default salvageService;
