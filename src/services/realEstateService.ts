import api from './api';

// Types
export interface PropertyDetails {
  owner_name: string;
  address: string;
  land_description: string;
  municipality: string;
  title_number: string;
  parcel_number: string;
  land_area_acres: string;
  source_quarter_section: string;
  property_type?: string;
}

export interface ReportDates {
  report_date: string;
  effective_date: string;
  inspection_date: string;
}

export interface HouseDetails {
  year_built: string;
  square_footage: string;
  lot_size_sqft: string;
  number_of_rooms: string;
  number_of_full_bathrooms: string;
  number_of_half_bathrooms: string;
  known_issues: string[];
}

export interface FarmlandDetails {
  total_title_acres?: number;
  cultivated_acres?: number;
  rm_area?: string;
  soil_class?: string;
  crop_type?: string;
  is_rented?: boolean;
  annual_rent_per_acre?: number;
  irrigation?: boolean;
  access_quality?: 'excellent' | 'good' | 'fair' | 'poor';
  distance_to_city_km?: number;
  use_direct_comparable?: boolean;
  subject_name?: string;
  valuation_date?: string;
  notes?: string;
  use_income_approach?: boolean;
  market_rent_per_acre?: number;
  vacancy_loss_percent?: number;
  operating_expense_ratio?: number;
  cap_rate?: number;
  use_cost_approach?: boolean;
}

export interface InspectorInfo {
  inspector_name: string;
  company_name: string;
  contact_email: string;
  contact_phone: string;
  credentials: string;
}

export interface RealEstateDetails {
  language?: 'en' | 'fr' | 'es';
  property_type?: 'agricultural' | 'commercial' | 'residential';
  property_details: PropertyDetails;
  report_dates: ReportDates;
  house_details: HouseDetails;
  farmland_details?: FarmlandDetails;
  inspector_info: InspectorInfo;
}

export interface RealEstateCreateResponse {
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
  details: RealEstateDetails,
  images: Array<{ uri: string; name: string; type: string }>,
  mapImage?: { uri: string; name: string; type: string }
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

  if (mapImage) {
    formData.append('mapImage', {
      uri: mapImage.uri,
      name: mapImage.name || 'map.jpg',
      type: mapImage.type || 'image/jpeg',
    } as any);
  }

  return formData;
};

const realEstateService = {
  /**
   * Create a new real estate report
   */
  async create(
    details: RealEstateDetails,
    images: Array<{ uri: string; name: string; type: string }>,
    mapImage?: { uri: string; name: string; type: string },
    onUploadProgress?: (progress: number) => void
  ): Promise<RealEstateCreateResponse> {
    const formData = createFormData(details, images, mapImage);

    const response = await api.post<RealEstateCreateResponse>('/real-estate', formData, {
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
   * Get progress of a real estate report job
   */
  async getProgress(jobId: string): Promise<ProgressData> {
    const response = await api.get<ProgressData>(`/real-estate/progress/${jobId}`);
    return response.data;
  },
};

export default realEstateService;
