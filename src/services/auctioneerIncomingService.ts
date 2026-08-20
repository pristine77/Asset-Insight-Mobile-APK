import api from './api';
import type { AuctionManagementTaskPayload } from './auctionManagementService';

export type AuctioneerIncomingStatus = 'available' | 'claimed' | 'report_created' | 'sent';

export interface AuctioneerIncomingTask {
  cycleKey: string;
  contractId: string;
  contractNo: string;
  customerName?: string;
  eventTitle?: string;
  eventDate?: string;
  location?: string;
  kind: 'scheduleA' | 'unknown';
  lotCount: number;
  pendingLotCount: number;
  status: AuctioneerIncomingStatus;
  assignedToCurrentUser: boolean;
  workItemId?: string;
  selectedReportType?: 'asset' | 'lotListing';
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function asPositiveCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function normalizeAuctioneerIncoming(value: unknown): AuctioneerIncomingTask[] {
  const records = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.data)
      ? (value as any).data
      : [];

  return records.flatMap((record: any) => {
    const cycleKey = asString(record?.cycleKey);
    const contractId = asString(record?.contractId);
    const contractNo = asString(record?.contractNo);
    if (!cycleKey || !contractId || !contractNo || record?.assignedToCurrentUser !== true) {
      return [];
    }

    const status = asString(record?.status) as AuctioneerIncomingStatus | undefined;
    if (!status || !['available', 'claimed', 'report_created', 'sent'].includes(status)) {
      return [];
    }

    return [{
      cycleKey,
      contractId,
      contractNo,
      customerName: asString(record.customerName),
      eventTitle: asString(record.eventTitle),
      eventDate: asString(record.eventDate),
      location: asString(record.location),
      kind: record.kind === 'unknown' ? 'unknown' : 'scheduleA',
      lotCount: asPositiveCount(record.lotCount),
      pendingLotCount: asPositiveCount(record.pendingLotCount),
      status,
      assignedToCurrentUser: true,
      workItemId: asString(record.workItemId),
      selectedReportType: record.selectedReportType === 'asset' || record.selectedReportType === 'lotListing'
        ? record.selectedReportType
        : undefined,
    }];
  });
}

function asRecords(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === 'object') : [];
}

function toLotListingTask(setup: Record<string, any>): AuctionManagementTaskPayload {
  const contract = setup.contract || {};
  const serviceCatalog = asRecords(setup.serviceCatalog).map((catalog) => ({
    rowGuid: asString(catalog.rowGuid) || '',
    contractCode: asString(catalog.contractCode),
    name: asString(catalog.name),
    description: asString(catalog.description),
    services: asRecords(catalog.services).map((service) => ({
      rowGuid: asString(service.rowGuid) || '',
      revenueContractId: asString(service.revenueContractId) || asString(catalog.rowGuid) || '',
      serviceName: asString(service.serviceName) || 'Service',
      defaultPrice: asString(service.defaultPrice),
      unit: asString(service.unit),
      gstPercent: asString(service.gstPercent),
      pstPercent: asString(service.pstPercent),
    })).filter((service) => service.rowGuid),
  })).filter((catalog) => catalog.rowGuid);
  return {
    task: {
      rowGuid: asString(setup.workItemId) || '',
      auctioneerWorkItemId: asString(setup.workItemId),
      status: 'in_progress',
    },
    contract: {
      rowGuid: asString(contract.id) || '',
      contractNumber: asString(contract.contractNo),
      saleLocation: asString(contract.location),
    },
    customer: contract.customerName ? { rowGuid: '', name: asString(contract.customerName) } : null,
    event: asString(contract.eventId) ? {
      rowGuid: asString(contract.eventId) || '',
      title: asString(contract.eventTitle),
      eventDate: asString(contract.eventDate),
      location: asString(contract.location),
    } : null,
    lots: asRecords(setup.lots).map((lot, index) => ({
      id: asString(lot.sourceKey) || `auctioneer-lot-${index + 1}`,
      label: asString(lot.title) || asString(lot.description) || `Lot ${index + 1}`,
      source: 'auctioneer',
      sourceLotId: asString(lot.lotId),
      lotNumber: asString(lot.lotNumber),
      year: asString(lot.year),
      make: asString(lot.make),
      model: asString(lot.model),
      serialNumber: asString(lot.serialNumber),
      description: asString(lot.description),
      selectedServiceIds: asRecords([lot]).flatMap((item) => Array.isArray(item.selectedServiceIds) ? item.selectedServiceIds.filter((id: unknown): id is string => typeof id === 'string') : []),
    })),
    serviceCatalog,
  };
}

class AuctioneerIncomingService {
  async getIncoming(refresh = false): Promise<AuctioneerIncomingTask[]> {
    const response = await api.get('/auctioneer/incoming', { params: refresh ? { refresh: 'true' } : undefined });
    return normalizeAuctioneerIncoming(response.data);
  }

  async openLotListingTask(task: AuctioneerIncomingTask): Promise<AuctionManagementTaskPayload> {
    if (task.selectedReportType && task.selectedReportType !== 'lotListing') {
      throw new Error('This assignment is already linked to a different report type.');
    }
    let workItemId = task.workItemId;
    if (!workItemId) {
      const claim = await api.post(`/auctioneer/incoming/${encodeURIComponent(task.cycleKey)}/claim`, { reportType: 'lotListing' });
      workItemId = asString(claim.data?.data?.workItemId);
    }
    if (!workItemId) throw new Error('Auctioneer did not return a work-item identifier.');
    const setup = await api.get(`/auctioneer/work-items/${encodeURIComponent(workItemId)}/setup`);
    return toLotListingTask(setup.data?.data || {});
  }
}

export default new AuctioneerIncomingService();
