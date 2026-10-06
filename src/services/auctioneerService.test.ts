import api from './api';
import auctioneerService, { isEditableAuctioneerSetup, parseAuctioneerSetup, validateAuctioneerSuccessor } from './auctioneerService';
import { auctioneerSeedLots, auctioneerLotSource, hasValidAuctioneerLotStructure } from '../components/forms/auctioneerFormPolicy';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const fixture = () => ({
  workItemId: 'parent', cycleKey: 'cycle', reportType: 'asset' as const, kind: 'scheduleA' as const,
  clientSubmissionId: 'submission-parent', status: 'claimed' as const, reportId: null,
  contract: { id: 'contract', contractNo: '93530.3-A' },
  lots: [{ sourceKey: 'source-one', lotId: 'lot-one' }, { sourceKey: 'source-two', lotId: 'lot-two' }],
});
beforeEach(() => jest.clearAllMocks());

it('accepts optional/null display metadata and preserves explicit used-report state', () => {
  const parsed = parseAuctioneerSetup({ ...fixture(), contract: { ...fixture().contract, customerName: null }, status: 'report_created', reportId: 'report' });
  expect(parsed.contract).toMatchObject({ customerName: '', eventTitle: '', location: '' });
  expect(parsed.reportId).toBe('report');
  expect(isEditableAuctioneerSetup(parsed, 'asset')).toBe(false);
});

it.each([{}, { ...fixture(), lots: null }, { ...fixture(), workItemId: '' }, { ...fixture(), status: 'future-state' }, { ...fixture(), contract: { id: 'contract', contractNo: '93530.3-A', eventDate: {} } }])('rejects incomplete or unsafe setup %#', (value) => {
  expect(() => parseAuctioneerSetup(value)).toThrow(/incomplete/);
});

it('claims by encoded cycle key and then fetches the full authoritative setup', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { workItemId: 'work/1 ?' } } });
  jest.mocked(api.get).mockResolvedValue({ data: { data: { ...fixture(), workItemId: 'work/1 ?' } } });
  const value = await auctioneerService.claim('cycle/1 ?', 'asset');
  expect(api.post).toHaveBeenCalledWith('/auctioneer/incoming/cycle%2F1%20%3F/claim', { reportType: 'asset' });
  expect(api.get).toHaveBeenCalledWith('/auctioneer/work-items/work%2F1%20%3F/setup');
  expect(value.workItemId).toBe('work/1 ?');
});

it('continues only with an explicit report ID and never sends previous source lots', async () => {
  const next = { ...fixture(), workItemId: 'next', clientSubmissionId: 'submission-next', kind: 'unknown', lots: [] };
  jest.mocked(api.post).mockResolvedValue({ data: { data: next } });
  await expect(auctioneerService.continueWorkItem('parent/1', '')).rejects.toThrow(/accepted report/);
  expect(api.post).not.toHaveBeenCalled();
  const result = await auctioneerService.continueWorkItem('parent/1', 'report-parent');
  expect(api.post).toHaveBeenCalledWith('/auctioneer/work-items/parent%2F1/continue', { reportId: 'report-parent' });
  expect(() => validateAuctioneerSuccessor(parseAuctioneerSetup(fixture()), result)).not.toThrow();
  expect(auctioneerSeedLots(result)).toEqual([]);
  expect(auctioneerLotSource(result, 0)).toEqual({});
});

it.each([
  { workItemId: 'parent' }, { clientSubmissionId: 'submission-parent' }, { status: 'report_created', reportId: 'existing' },
  { kind: 'scheduleA' }, { lots: [{ sourceKey: 'old-source' }] }, { reportType: 'lotListing' },
  { contract: { id: 'other', contractNo: '93530.3-A' } }, { status: 'abandoned' },
])('rejects unsafe successor %#', (change) => {
  const previous = parseAuctioneerSetup(fixture());
  const next = parseAuctioneerSetup({ ...fixture(), workItemId: 'next', clientSubmissionId: 'submission-next', kind: 'unknown', lots: [], ...change });
  expect(() => validateAuctioneerSuccessor(previous, next)).toThrow(/not a fresh lot/);
});

it('locks Schedule A identities, count, order and grouping while allowing original media edits', () => {
  const current = parseAuctioneerSetup(fixture());
  const lots = auctioneerSeedLots(current);
  expect(hasValidAuctioneerLotStructure(current, lots)).toBe(true);
  expect(hasValidAuctioneerLotStructure(current, lots.slice(1))).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, [...lots].reverse())).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, [...lots, lots[0]])).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, lots.map((lot) => ({ ...lot, mode: 'per_photo' })))).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, lots.map((lot) => ({ ...lot, files: [{ uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }] })))).toBe(true);
  expect(auctioneerLotSource(current, 1)).toEqual({ source_key: 'source-two', source_lot_id: 'lot-two', source_submission_id: undefined });
});
