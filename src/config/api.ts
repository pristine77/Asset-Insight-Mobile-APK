// API Configuration
// Change this to your production API URL when deploying
export const API_BASE_URL = "https://api.assetinsightvaluator.com/api";

// For local development, uncomment the appropriate line:
// export const API_BASE_URL = "http://localhost:4000/api"; // Web/iOS Simulator
// export const API_BASE_URL = "http://10.0.2.2:4000/api"; // Android Emulator

export const API_ENDPOINTS = {
  LOGIN: "/auth/login",
  SIGNUP: "/auth/signup",
  REFRESH_TOKEN: "/auth/refresh-token",
  LOGOUT: "/auth/logout",
  VERIFY_EMAIL: "/auth/verify-email",
  RESEND_VERIFICATION_CODE: "/auth/resend-verification-code",
  FORGOT_PASSWORD: "/auth/forgot-password",
  RESET_PASSWORD_CODE: "/auth/reset-password-code",
  RESET_PASSWORD: "/auth/reset-password",
  ME: "/user/me",
  // Asset endpoints
  CREATE_ASSET: "/asset",
  GET_ASSETS: "/asset",
  GET_ASSET_PROGRESS: "/asset/progress",
  GET_PREVIEW: "/asset",
  UPDATE_PREVIEW: "/asset",
  SUBMIT_PREVIEW: "/asset",
  // Real Estate endpoints
  GET_REAL_ESTATE_PREVIEW: "/real-estate/preview",
  UPDATE_REAL_ESTATE_PREVIEW: "/real-estate/preview",
  SUBMIT_REAL_ESTATE_PREVIEW: "/real-estate/preview",
  // Lot Listing endpoints
  CREATE_LOT_LISTING: "/lot-listing",
  GET_LOT_LISTINGS: "/lot-listing",
  GET_LOT_LISTING_PROGRESS: "/lot-listing/progress",
  // CRM endpoints
  CRM_MY_TASKS: "/crm/tasks/my",
  CRM_TASKS_QUICK_ADD: "/crm/tasks/quick-add",
  CRM_TASKS: "/crm/tasks",
  CRM_TASK_COMMENT_TRANSCRIBE: "/crm/tasks/comment/transcribe",
  CRM_EMAIL_REWRITE: "/crm/tasks/email/rewrite",
  CRM_OUTLOOK_STATUS: "/crm/calendar/ms/outlook/status",
  CRM_OUTLOOK_AUTH_URL: "/crm/calendar/ms/outlook/auth-url",
  CRM_OUTLOOK_DISCONNECT: "/crm/calendar/ms/outlook/disconnect",
  CRM_OUTLOOK_BULK_ADD: "/crm/tasks/calendar/ms/outlook/bulk",
  CRM_TRANSFER_AGENTS: "/crm/tasks/transfer/agents",
  CRM_TRANSFER_INBOX: "/crm/tasks/transfers/my",
};
