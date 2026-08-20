jest.mock('./api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

import auctioneerIncomingService, { normalizeAuctioneerIncoming } from './auctioneerIncomingService';
import api from './api';

describe('normalizeAuctioneerIncoming', () => {
  it('keeps assigned Auctioneer batches and exposes lots waiting under an active contract', () => {
    expect(normalizeAuctioneerIncoming({
      success: true,
      data: [{
        cycleKey: 'cycle-1',
        contractId: 'contract-1',
        contractNo: 'SR0099',
        lotCount: 1,
        pendingLotCount: 2,
        status: 'claimed',
        assignedToCurrentUser: true,
        kind: 'scheduleA',
      }],
    })).toEqual([expect.objectContaining({
      contractNo: 'SR0099',
      lotCount: 1,
      pendingLotCount: 2,
      status: 'claimed',
    })]);
  });

  it('does not expose work assigned to another Asset Insight user', () => {
    expect(normalizeAuctioneerIncoming({
      data: [{
        cycleKey: 'cycle-1',
        contractId: 'contract-1',
        contractNo: 'SR0099',
        status: 'available',
        assignedToCurrentUser: false,
      }],
    })).toEqual([]);
  });

  it('opens an assigned work item with its catalog and current services ready for editing', async () => {
    const [task] = normalizeAuctioneerIncoming({
      data: [{
        cycleKey: 'cycle-1',
        contractId: 'contract-1',
        contractNo: 'SR0099',
        lotCount: 1,
        pendingLotCount: 0,
        status: 'claimed',
        assignedToCurrentUser: true,
        workItemId: 'work-item-1',
        selectedReportType: 'lotListing',
      }],
    });
    (api.get as jest.Mock).mockResolvedValueOnce({
      data: {
        data: {
          workItemId: 'work-item-1',
          contract: { id: 'contract-1', contractNo: 'SR0099', customerName: 'Northstar' },
          serviceCatalog: [{
            rowGuid: 'rc-1',
            name: 'Services',
            services: [{ rowGuid: 'svc-1', revenueContractId: 'rc-1', serviceName: 'Steam Wash', defaultPrice: '45.50' }],
          }],
          lots: [{ sourceKey: 'source-1', lotId: 'lot-1', description: 'Loader', selectedServiceIds: ['svc-1'] }],
        },
      },
    });

    const opened = await auctioneerIncomingService.openLotListingTask(task);

    expect(api.get).toHaveBeenCalledWith('/auctioneer/work-items/work-item-1/setup');
    expect(opened.task.auctioneerWorkItemId).toBe('work-item-1');
    expect(opened.lots[0].selectedServiceIds).toEqual(['svc-1']);
    expect(opened.serviceCatalog[0].services[0]).toMatchObject({ serviceName: 'Steam Wash', defaultPrice: '45.50' });
  });
});
