import api from './api';
import type { UploadContinuationReservation } from './durableContinuationTypes';

export type AuctioneerReportType = 'asset' | 'lotListing';
export type AuctioneerWorkItemStatus = 'available' | 'claimed' | 'report_created' | 'sent' | 'abandoned';

export interface AuctioneerIncomingItem {
  cycleKey: string;
  workItemId?: string;
  contractId: string;
  contractNo: string;
  customerName: string;
  eventId?: string;
  eventTitle: string;
  eventDate?: string;
  location: string;
  kind: 'scheduleA' | 'unknown';
  lotCount: number;
  status: AuctioneerWorkItemStatus;
  claimedByMe?: boolean;
  selectedReportType?: AuctioneerReportType;
}

export interface AuctioneerSourceLot {
  sourceKey: string;
  lotId?: string;
  submissionId?: string;
  lotNumber?: string;
  title?: string;
  description?: string;
  categories?: string;
}

export interface AuctioneerWorkItemSetup {
  workItemId: string;
  cycleKey: string;
  kind: 'scheduleA' | 'unknown';
  reportType: AuctioneerReportType;
  clientSubmissionId?: string;
  status?: AuctioneerWorkItemStatus;
  reportId?: string | null;
  canResumeUpload?: boolean;
  contract: {
    id: string;
    contractNo: string;
    customerName: string;
    eventId?: string;
    eventTitle: string;
    eventDate?: string;
    location: string;
    categories?: string;
  };
  lots: AuctioneerSourceLot[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string => text(value) && value.trim().length > 0;

export function parseAuctioneerSetup(value: unknown): AuctioneerWorkItemSetup {
  if (!record(value) || !id(value.workItemId) || !id(value.cycleKey) ||
      !['scheduleA', 'unknown'].includes(String(value.kind)) ||
      !['asset', 'lotListing'].includes(String(value.reportType)) ||
      !record(value.contract) || !id(value.contract.id) || !id(value.contract.contractNo) ||
      !['customerName', 'eventTitle', 'location', 'eventId', 'eventDate', 'categories'].every((key) => (value.contract as Record<string, unknown>)[key] == null || text((value.contract as Record<string, unknown>)[key])) ||
      !Array.isArray(value.lots) || !value.lots.every((lot) => record(lot) && id(lot.sourceKey)) ||
      (value.clientSubmissionId != null && !id(value.clientSubmissionId)) ||
      (value.reportId != null && !id(value.reportId)) ||
      (value.canResumeUpload != null && typeof value.canResumeUpload !== 'boolean') ||
      (value.status != null && !['available', 'claimed', 'report_created', 'sent', 'abandoned'].includes(String(value.status)))) {
    throw new Error('The Auctioneer work-item setup is incomplete. Reload Incoming and try again.');
  }
  return { ...value, contract: {
    ...value.contract,
    customerName: value.contract.customerName || '',
    eventTitle: value.contract.eventTitle || '',
    location: value.contract.location || '',
  } } as unknown as AuctioneerWorkItemSetup;
}

export function isEditableAuctioneerSetup(setup: AuctioneerWorkItemSetup, type: AuctioneerReportType): boolean {
  return setup.reportType === type && setup.status === 'claimed' && !setup.reportId &&
    Boolean(setup.clientSubmissionId) && (setup.kind !== 'scheduleA' || setup.lots.length > 0);
}

export function validateAuctioneerSuccessor(previous: AuctioneerWorkItemSetup, next: AuctioneerWorkItemSetup): void {
  if (!isEditableAuctioneerSetup(next, previous.reportType) || next.workItemId === previous.workItemId ||
      next.clientSubmissionId === previous.clientSubmissionId || next.contract.id !== previous.contract.id ||
      next.contract.contractNo !== previous.contract.contractNo ||
      (Boolean(previous.contract.eventId) && next.contract.eventId !== previous.contract.eventId) ||
      next.kind !== 'unknown' || next.lots.length !== 0) {
    throw new Error('The next work item is not a fresh lot. Reload Incoming to check its status; no replacement lot was opened.');
  }
}

class AuctioneerService {
  async getStatus(): Promise<{ configured: boolean; enabled: boolean; reachable?: boolean; message?: string }> {
    const response = await api.get('/auctioneer/status');
    const value = response.data?.data;
    if (!record(value) || typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean') {
      throw new Error('Auctioneer connection status is unavailable.');
    }
    return value as { configured: boolean; enabled: boolean; reachable?: boolean; message?: string };
  }

  async getIncoming(forceRefresh = false): Promise<AuctioneerIncomingItem[]> {
    const response = await api.get('/auctioneer/incoming', forceRefresh ? { params: { refresh: true } } : undefined);
    const value = response.data?.data;
    const rows = Array.isArray(value) ? value : value?.items;
    if (!Array.isArray(rows) || !rows.every((row) => record(row) && id(row.cycleKey) && id(row.contractNo) &&
        ['available', 'claimed', 'report_created', 'sent', 'abandoned'].includes(String(row.status)))) {
      throw new Error('The Auctioneer incoming list is incomplete. Try refreshing it.');
    }
    return rows.map((row) => ({ ...row, customerName: row.customerName || '', eventTitle: row.eventTitle || '', location: row.location || '' })) as AuctioneerIncomingItem[];
  }

  async claim(cycleKey: string, reportType: AuctioneerReportType): Promise<AuctioneerWorkItemSetup> {
    const response = await api.post(`/auctioneer/incoming/${encodeURIComponent(cycleKey)}/claim`, { reportType });
    const value = response.data?.data;
    if (!record(value) || !id(value.workItemId)) throw new Error('The Auctioneer claim did not return a work item. Refresh Incoming before retrying.');
    return this.getSetup(value.workItemId);
  }

  async getSetup(workItemId: string): Promise<AuctioneerWorkItemSetup> {
    const response = await api.get(`/auctioneer/work-items/${encodeURIComponent(workItemId)}/setup`);
    return parseAuctioneerSetup(response.data?.data);
  }

  async continueWorkItem(workItemId: string, reportId: string): Promise<AuctioneerWorkItemSetup> {
    if (!id(workItemId) || !id(reportId)) throw new Error('A server-accepted report is required before starting a new lot.');
    const response = await api.post(`/auctioneer/work-items/${encodeURIComponent(workItemId)}/continue`, { reportId });
    return parseAuctioneerSetup(response.data?.data);
  }

  async continueUpload(workItemId: string, sessionId: string): Promise<{ reservation: UploadContinuationReservation; setup: AuctioneerWorkItemSetup }> {
    const response = await api.post(`/auctioneer/work-items/${encodeURIComponent(workItemId)}/continue-upload`, { sessionId }, { timeout: 30_000 });
    const data = response.data?.data;
    if (!record(data) || !record(data.reservation) || data.reservation.status !== 'reserved' ||
        !['id', 'ownerId', 'parentWorkItemId', 'parentSessionId', 'parentClientSubmissionId', 'parentCaptureId', 'successorWorkItemId'].every(key => id((data.reservation as Record<string, unknown>)[key]))) {
      throw new Error('The next-lot reservation could not be verified. Retry this same Continue request from Drafts.');
    }
    return { reservation: data.reservation as UploadContinuationReservation, setup: parseAuctioneerSetup(data.setup) };
  }
}

export default new AuctioneerService();
