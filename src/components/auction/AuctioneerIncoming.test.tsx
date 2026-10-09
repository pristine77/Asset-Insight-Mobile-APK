import React from 'react';
import { act, fireEvent, render as nativeRender, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../context/ThemeContext';
import AuctioneerIncoming from './AuctioneerIncoming';
import AuctionManagementScreen from '../../screens/AuctionManagementScreen';
import DrawerContent from '../DrawerContent';
import auctioneerService, {
  type AuctioneerIncomingItem,
  type AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';
import legacyService from '../../services/auctionManagementService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';

let mockPanelOwner: string | undefined;

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { _id: mockPanelOwner, username: 'Test appraiser' }, logout: jest.fn() }),
}));
jest.mock('../../services/auctioneerService', () => ({
  __esModule: true,
  default: { getStatus: jest.fn(), getIncoming: jest.fn(), getSetup: jest.fn(), claim: jest.fn() },
}));
jest.mock('../../services/auctionManagementService', () => ({
  __esModule: true,
  default: { getTasks: jest.fn(), getTask: jest.fn(), markOpened: jest.fn() },
}));
jest.mock('../forms/AssetFormSheet', () => {
  const { Text, View, TouchableOpacity } = jest.requireActual('react-native');
  return (props: any) => {
    const [boundarySession] = require('react').useState(props.auctioneer.workItemId);
    return props.visible ? (
      <View>
        <Text>Boundary session {boundarySession}</Text>
        <Text>Asset form {props.auctioneer.workItemId}</Text>
        <Text>Imported {props.auctioneer.contract.contractNo}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Accepted next form"
          onPress={() =>
            props.onAuctioneerSetupChange({
              ...props.auctioneer,
              workItemId: 'child-2',
              clientSubmissionId: 'submission-2',
              kind: 'unknown',
              lots: [],
            })
          }>
          <Text>Next</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close Asset form"
          onPress={props.onClose}>
          <Text>Close</Text>
        </TouchableOpacity>
      </View>
    ) : null;
  };
});
jest.mock('../forms/LotListingFormSheet', () => {
  const { Text, View } = jest.requireActual('react-native');
  return (props: any) =>
    props.visible ? (
      <View>
        <Text>Lot form {props.auctioneer?.workItemId || 'legacy'}</Text>
      </View>
    ) : null;
});

const render = (element: React.ReactElement) =>
  nativeRender(<ThemeProvider>{element}</ThemeProvider>);

const available: AuctioneerIncomingItem = {
  cycleKey: 'cycle-1',
  contractId: 'contract-1',
  contractNo: '93530',
  customerName: 'Imported customer',
  eventTitle: 'Sale',
  location: 'Regina',
  kind: 'scheduleA',
  lotCount: 2,
  status: 'available',
};
const setup: AuctioneerWorkItemSetup = {
  workItemId: 'work-1',
  cycleKey: 'cycle-1',
  kind: 'scheduleA',
  reportType: 'asset',
  clientSubmissionId: 'submission-1',
  status: 'claimed',
  contract: {
    id: 'contract-1',
    contractNo: '93530',
    customerName: 'Imported customer',
    eventTitle: 'Sale',
    location: 'Regina',
  },
  lots: [{ sourceKey: 'source-1', lotId: 'existing-lot' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPanelOwner = undefined;
  jest.mocked(auctioneerService.getStatus).mockResolvedValue({ configured: true, enabled: true });
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([available]);
  jest.mocked(auctioneerService.claim).mockResolvedValue(setup);
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(setup);
  jest.mocked(legacyService.getTasks).mockResolvedValue([]);
});

it('keeps pending Continue recovery inside the assigned-contract scroll list on short screens', async () => {
  mockPanelOwner = 'owner';
  const owner = jest.spyOn(OfflineCaptureStore, 'getOwnerId').mockReturnValue('owner');
  const rows = jest.spyOn(OfflineCaptureStore, 'listContinuations').mockResolvedValue([{ id: 'pending', ownerId: 'owner', type: 'asset', stage: 'staged', parentSetup: { contract: { contractNo: 'pending-contract' } } }] as any);
  try {
    await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
    const button = await screen.findByRole('button', { name: 'Retry next lot for pending-contract' });
    const ancestors: string[] = [];
    for (let parent = button.parent; parent; parent = parent.parent) ancestors.push(parent.type);
    expect(ancestors.some(type => /ScrollView/.test(type))).toBe(true);
  } finally { owner.mockRestore(); rows.mockRestore(); }
});

it.each(['asset', 'lotListing'] as const)(
  'opens an assigned contract in the selected %s form',
  async (type) => {
    jest.mocked(auctioneerService.claim).mockResolvedValue({ ...setup, reportType: type });
    await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
    await fireEvent.press(
      await screen.findByRole('button', {
        name: `Open contract 93530 as ${type === 'asset' ? 'Asset' : 'Lot Listing'}`,
      })
    );
    expect(auctioneerService.claim).toHaveBeenCalledWith('cycle-1', type);
    expect(
      await screen.findByText(`${type === 'asset' ? 'Asset' : 'Lot'} form work-1`)
    ).toBeTruthy();
    expect(legacyService.markOpened).not.toHaveBeenCalled();
  }
);

it('locks both claim choices until the same request completes', async () => {
  let resolve!: (value: AuctioneerWorkItemSetup) => void;
  jest.mocked(auctioneerService.claim).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Open contract 93530 as Asset' })
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Open contract 93530 as Lot Listing' }));
  expect(auctioneerService.claim).toHaveBeenCalledTimes(1);
  await act(async () => resolve(setup));
  expect(await screen.findByText('Asset form work-1')).toBeTruthy();
});

it('replaces an accepted form with the returned successor without claiming again', async () => {
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Open contract 93530 as Asset' })
  );
  await fireEvent.press(await screen.findByRole('button', { name: 'Accepted next form' }));
  expect(await screen.findByText('Asset form child-2')).toBeTruthy();
  expect(screen.queryByText('Asset form work-1')).toBeNull();
  expect(screen.getByText('Imported 93530')).toBeTruthy();
  expect(screen.getByText('Boundary session work-1')).toBeTruthy();
  expect(auctioneerService.claim).toHaveBeenCalledTimes(1);
});

it('opens an already-used work item as its saved report, not a new capture', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([
      {
        ...available,
        status: 'report_created',
        claimedByMe: true,
        workItemId: 'work-1',
        selectedReportType: 'lotListing',
      },
    ]);
  jest
    .mocked(auctioneerService.getSetup)
    .mockResolvedValue({
      ...setup,
      reportType: 'lotListing',
      status: 'report_created',
      reportId: 'saved-report',
    });
  const onOpenReport = jest.fn();
  await render(<AuctioneerIncoming onOpenReport={onOpenReport} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Open contract 93530' }));
  expect(onOpenReport).toHaveBeenCalledWith('saved-report', 'lotListing');
  expect(auctioneerService.claim).not.toHaveBeenCalled();
  expect(screen.queryByText('Lot form work-1')).toBeNull();
});

it('does not load contracts when the backend feature is disabled', async () => {
  jest.mocked(auctioneerService.getStatus).mockResolvedValue({ configured: true, enabled: false });
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText(/not enabled or configured/)).toBeTruthy();
  expect(auctioneerService.getIncoming).not.toHaveBeenCalled();
});

it('shows a retryable connection error without opening a form', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockRejectedValueOnce(new Error('Connection unavailable'));
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Connection unavailable')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry assigned contracts' }));
  expect(await screen.findByText('Contract 93530')).toBeTruthy();
  expect(auctioneerService.getIncoming).toHaveBeenLastCalledWith(true);
  expect(auctioneerService.claim).not.toHaveBeenCalled();
});

it('does not expose open actions for work claimed by another user', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([{ ...available, status: 'claimed', claimedByMe: false }]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('This work is not available to open.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Open contract/ })).toBeNull();
});

it('keeps legacy Auctionsoft as the default and loads modern contracts only when selected', async () => {
  await render(<AuctionManagementScreen onOpenDrawer={jest.fn()} onOpenReport={jest.fn()} />);
  expect(legacyService.getTasks).toHaveBeenCalledWith('incoming');
  expect(auctioneerService.getStatus).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('tab', { name: 'Auctioneer 2.0 contracts' }));
  expect(await screen.findByText('Contract 93530')).toBeTruthy();
  expect(auctioneerService.getStatus).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('tab', { name: 'Legacy Auctionsoft tasks' }));
  expect(screen.queryByText('Contract 93530')).toBeNull();
});

it('provides a reachable Incoming entry in the listing drawer', async () => {
  const onNavigate = jest.fn();
  const onClose = jest.fn();
  await render(
    <DrawerContent activeScreen="auctionManagement" onNavigate={onNavigate} onClose={onClose} />
  );
  const incoming = screen.getByRole('button', { name: 'Incoming' });
  expect(incoming.props.accessibilityState.selected).toBe(true);
  await fireEvent.press(incoming);
  expect(onNavigate).toHaveBeenCalledWith('auctionManagement');
  expect(onClose).toHaveBeenCalledTimes(1);
});
