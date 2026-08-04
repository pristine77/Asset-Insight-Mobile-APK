/* eslint-disable @typescript-eslint/no-explicit-any */
import api from "./api";
import { API_ENDPOINTS } from "../config/api";
import { uploadReportFilesDirectToR2, type DirectUploadFile } from "./directR2UploadService";
import type { ReportWorkflowStage } from './assetService';

export type LotListingMode = 'single_lot' | 'per_item' | 'per_photo';

export interface LotListingDetails {
  client_submission_id?: string;
  force_new?: boolean;
  contract_no: string;
  sales_date: string;
  location: string;
  latitude?: number;
  longitude?: number;
  language?: string;
  currency?: string;
  include_damage_analysis?: boolean;
  bank_photos_enabled?: boolean;
  valuation_methods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
  mixed_lots?: Array<{
    count: number;
    extra_count?: number;
    cover_index?: number;
    mode: LotListingMode;
  }>;
  focus_boxes?: Array<{ imageIndex: number; x: number; y: number; w: number; h: number }>;
  progress_id?: string;
  auctionsoft?: {
    taskId: string;
    contractId: string;
    contractNumber?: string | null;
    destination: 'LottingBoard' | 'OpToDoBoard';
    closeContract: boolean;
    submittedBy?: string;
    seedLots?: any[];
    selectedServicesByLot?: any[];
  };
}

export interface LotFile {
  uri: string;
  name: string;
  type: string;
  captureOrder?: number;
  originalOrder?: number;
}

export interface LotListingLot {
  id: string;
  files: LotFile[];
  extraFiles?: LotFile[];
  lot_number: string | number;
  mode?: LotListingMode;
  coverIndex?: number;
}

export interface LotListing {
  _id: string;
  contract_no: string;
  sales_date: string;
  location: string;
  imageUrls: string[];
  lots: any[];
  include_damage_analysis?: boolean;
  valuation_methods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
  status: "processing" | "preview" | "pending_approval" | "approved" | "declined" | "completed" | "error";
  preview_data?: {
    contract_no?: string;
    sales_date?: string;
    location?: string;
    include_damage_analysis?: boolean;
    bank_photos_enabled?: boolean;
    valuation_methods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
    lots?: any[];
  };
  preview_files?: {
    spec_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  files?: {
    spec_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  decline_reason?: string;
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
  generation_state?: 'queued' | 'processing' | 'ready' | 'error';
  workflow_stage?: ReportWorkflowStage;
  workflow_message?: string;
  workflow_progress_percent?: number;
  generation_progress?: {
    stage?: string;
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
    updatedAt?: string;
  };
  job_status?: 'queued' | 'processing' | 'done' | 'error';
  job_error?: string;
  files_ready?: boolean;
  preview_submitted_at?: string;
  approval_requested_at?: string;
  generation_target_status?: 'preview' | 'pending_approval' | 'approved';
  createdAt: string;
  updatedAt: string;
}

export interface ProgressData {
  id: string;
  phase: string;
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

class LotListingService {
  /**
   * Create a new lot listing with images - uses same AI processing as Asset
   */
  async createLotListing(
    details: LotListingDetails,
    lots: LotListingLot[],
    onUploadProgress?: (progress: number) => void
  ): Promise<{ jobId: string; message: string; reportId?: string; status?: string; phase?: string }> {
    const mixedLots = lots.map((lot) => ({
      count: lot.files.length,
      extra_count: lot.extraFiles?.length || 0,
      cover_index: lot.coverIndex || 0,
      mode: lot.mode || 'single_lot',
    }));
    const directDetails = {
      ...details,
      include_damage_analysis: details.include_damage_analysis !== false,
      valuation_methods: details.valuation_methods?.length ? details.valuation_methods : ['FML'],
      mixed_lots: mixedLots,
    };

    try {
      const files: DirectUploadFile[] = [];
      lots.forEach((lot, lotIndex) => {
        lot.files.forEach((file, imageIndex) => {
          files.push({
            uri: file.uri,
            name: file.name || `lot-${lotIndex + 1}-main-${imageIndex + 1}.jpg`,
            type: file.type || "image/jpeg",
            fieldname: "images",
            lotIndex,
            imageIndex,
            captureOrder: file.captureOrder ?? imageIndex,
            originalOrder: file.originalOrder ?? file.captureOrder ?? imageIndex,
            role: "main",
          });
        });
        (lot.extraFiles || []).forEach((file, imageIndex) => {
          files.push({
            uri: file.uri,
            name: file.name || `lot-${lotIndex + 1}-extra-${imageIndex + 1}.jpg`,
            type: file.type || "image/jpeg",
            fieldname: "images",
            lotIndex,
            imageIndex,
            captureOrder: file.captureOrder ?? imageIndex,
            originalOrder: file.originalOrder ?? file.captureOrder ?? imageIndex,
            role: "extra",
          });
        });
      });

      return await uploadReportFilesDirectToR2({
        endpoint: "/lot-listing",
        details: directDetails,
        files,
        onProgress: onUploadProgress,
      });
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      if (![404, 405, 501].includes(status)) throw error;
      console.warn("[LotListingService] Direct upload is unsupported; using legacy multipart upload.");
    }

    const formData = new FormData();

    // Build mixed_lots mapping for AI processing (same format as Asset)

    // Add details as JSON with mixed_lots format
    formData.append(
      "details",
      JSON.stringify(directDetails)
    );

    // Add all images from lots (main files first, then extra files)
    let imageIndex = 0;
    for (const lot of lots) {
      // Add main files
      for (const file of lot.files) {
        const fileObj = {
          uri: file.uri,
          name: file.name || `image-${imageIndex}.jpg`,
          type: file.type || "image/jpeg",
        } as any;
        formData.append("images", fileObj);
        imageIndex++;
      }
      // Add extra files
      for (const file of lot.extraFiles || []) {
        const fileObj = {
          uri: file.uri,
          name: file.name || `extra-${imageIndex}.jpg`,
          type: file.type || "image/jpeg",
        } as any;
        formData.append("images", fileObj);
        imageIndex++;
      }
    }

    const response = await api.post(API_ENDPOINTS.CREATE_LOT_LISTING, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
      timeout: 300000, // 5 minutes for large uploads
      onUploadProgress: (progressEvent: any) => {
        if (onUploadProgress && progressEvent.total) {
          const progress = Math.min(
            100,
            Math.round((progressEvent.loaded * 100) / progressEvent.total)
          );
          onUploadProgress(progress);
        }
      },
    });

    return response.data;
  }

  /**
   * Get all lot listings for current user
   */
  async getLotListings(): Promise<LotListing[]> {
    const response = await api.get(API_ENDPOINTS.GET_LOT_LISTINGS);
    return response.data.data || [];
  }

  /**
   * Get progress for a specific job
   */
  async getProgress(jobId: string): Promise<ProgressData | null> {
    try {
      const response = await api.get(
        `${API_ENDPOINTS.GET_LOT_LISTING_PROGRESS}/${jobId}`
      );
      return response.data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  }

  async getPreviewData(reportId: string): Promise<any> {
    const response = await api.get(`${API_ENDPOINTS.GET_LOT_LISTINGS}/${reportId}/preview`);
    return response.data.data;
  }

  async uploadPreviewLotImages(
    reportId: string,
    lotKey: string | number,
    images: Array<{ uri: string; name?: string | null; type?: string | null }>,
    previewData?: any,
    onUploadProgress?: (progress: number) => void
  ): Promise<any> {
    const formData = new FormData();
    images.forEach((image, index) => {
      const uriName = image.uri.split(/[\\/]/).pop() || `preview-image-${index + 1}.jpg`;
      formData.append("images", {
        uri: image.uri,
        name: image.name || uriName,
        type: image.type || "image/jpeg",
      } as any);
    });
    if (previewData) {
      formData.append("preview_data", JSON.stringify(previewData));
    }

    const response = await api.post(
      `${API_ENDPOINTS.GET_LOT_LISTINGS}/${reportId}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300000,
        onUploadProgress: (progressEvent: any) => {
          if (onUploadProgress && progressEvent.total) {
            onUploadProgress(Math.min(100, Math.round((progressEvent.loaded * 100) / progressEvent.total)));
          }
        },
      }
    );
    return response.data;
  }

  /**
   * Poll progress until complete
   */
  async pollProgress(
    jobId: string,
    onProgress: (data: ProgressData) => void,
    intervalMs: number = 2000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const data = await this.getProgress(jobId);
          if (!data) {
            reject(new Error("Progress not found"));
            return;
          }

          onProgress(data);

          if (data.phase === "done" || data.phase === "error") {
            resolve();
            return;
          }

          setTimeout(poll, intervalMs);
        } catch (e) {
          reject(e);
        }
      };

      poll();
    });
  }
}

export const lotListingService = new LotListingService();
export default lotListingService;
