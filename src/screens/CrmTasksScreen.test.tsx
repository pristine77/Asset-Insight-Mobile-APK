import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CrmTasksScreen from './CrmTasksScreen';
import crmTaskApi, { type CrmTaskItem } from '../services/crmService';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null, FontAwesome: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-av', () => ({ Audio: {} }));
jest.mock('expo-mail-composer', () => ({}));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('../context/AuthContext', () => {
  const user = { _id: 'agent-1', username: 'Test agent' };
  return { useAuth: () => ({ user, refreshUser: jest.fn() }) };
});
jest.mock('../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../services/crmService', () => ({
  ...jest.requireActual('../services/crmService'),
  __esModule: true,
  default: {
    getMyTasks: jest.fn(),
    getOutlookCalendarStatus: jest.fn(),
    getMyTransferRequests: jest.fn(),
    listTransferAgents: jest.fn(),
    submitTaskUpdate: jest.fn(),
    requestTaskTransfer: jest.fn(),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(crmTaskApi.getMyTasks).mockResolvedValue({
    items: [
      {
        _id: 'task-1',
        clientName: 'Example Client',
        status: 'new_lead',
        email: 'client@example.test',
        updates: [],
      } as unknown as CrmTaskItem,
    ],
    total: 1,
  } as Awaited<ReturnType<typeof crmTaskApi.getMyTasks>>);
  jest
    .mocked(crmTaskApi.getOutlookCalendarStatus)
    .mockResolvedValue({ connected: false, configured: true });
  jest.mocked(crmTaskApi.getMyTransferRequests).mockResolvedValue([]);
  jest
    .mocked(crmTaskApi.listTransferAgents)
    .mockResolvedValue([{ _id: 'agent-2', username: 'Receiving agent' }] as Awaited<
      ReturnType<typeof crmTaskApi.listTransferAgents>
    >);
});

it('keeps task comments stable through status edits and cancel does not submit', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Update Example Client' }));
  expect(screen.getByLabelText('Task update form').props.keyboardShouldPersistTaps).toBe('handled');
  const comment = screen.getByLabelText('Task comment');
  await fireEvent.changeText(comment, 'First finding\nSecond finding');
  await fireEvent.press(screen.getByRole('radio', { name: 'Task status: Contacted' }));
  expect(screen.getByLabelText('Task comment')).toBe(comment);
  expect(comment.props.value).toBe('First finding\nSecond finding');
  expect(screen.getByRole('button', { name: 'Submit task update' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel task update' }));
  expect(screen.queryByLabelText('Task comment')).toBeNull();
  expect(crmTaskApi.submitTaskUpdate).not.toHaveBeenCalled();
});

it('keeps transfer notes and actions scroll-reachable without changing the request rules', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Transfer Example Client' }));
  expect(screen.getByLabelText('Transfer task form').props.keyboardShouldPersistTaps).toBe(
    'handled'
  );
  expect(
    screen.getByRole('button', { name: 'Send transfer request' }).props.accessibilityState.disabled
  ).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Transfer note'), 'First line\nSecond line');
  await fireEvent.press(screen.getByRole('radio', { name: 'Receiving agent' }));
  expect(
    screen.getByRole('button', { name: 'Send transfer request' }).props.accessibilityState.disabled
  ).toBe(false);
  expect(screen.getByLabelText('Transfer note').props.value).toBe('First line\nSecond line');
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel task transfer' }));
  expect(crmTaskApi.requestTaskTransfer).not.toHaveBeenCalled();
});

it('keeps email message identity and multiline content while editing the subject', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Email Example Client' }));
  expect(screen.getByLabelText('Compose email form').props.keyboardShouldPersistTaps).toBe(
    'handled'
  );
  const message = screen.getByLabelText('Email message');
  await fireEvent.changeText(message, 'Hello\nPlease review the details.');
  await fireEvent.changeText(screen.getByLabelText('Email subject'), 'Review request');
  expect(screen.getByLabelText('Email message')).toBe(message);
  expect(message.props.value).toBe('Hello\nPlease review the details.');
  expect(screen.getByRole('button', { name: 'Send email' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel email' }));
  expect(screen.queryByLabelText('Email message')).toBeNull();
});
