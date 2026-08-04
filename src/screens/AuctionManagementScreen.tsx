import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import LotListingFormSheet from '../components/forms/LotListingFormSheet';
import auctionManagementService, {
  AuctionManagementTaskPayload,
  AuctionManagementTaskStatus,
} from '../services/auctionManagementService';

const emptyImage = require('../../assets/auction-management-empty.png');

interface AuctionManagementScreenProps {
  onOpenDrawer: () => void;
}

const TABS: { key: AuctionManagementTaskStatus; label: string; icon: string }[] = [
  { key: 'incoming', label: 'Incoming', icon: 'inbox' },
  { key: 'in_progress', label: 'New', icon: 'camera' },
  { key: 'completed', label: 'Completed', icon: 'check-circle' },
];

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function taskTitle(task: AuctionManagementTaskPayload) {
  const number = task.contract?.contractNumber || task.contract?.rowGuid || 'Contract';
  return `Contract ${number}`;
}

function customerName(task: AuctionManagementTaskPayload) {
  return task.customer?.name || task.customer?.company || 'Customer not set';
}

function locationLabel(task: AuctionManagementTaskPayload) {
  return (
    task.event?.location ||
    [task.event?.city, task.event?.province].filter(Boolean).join(', ') ||
    task.contract?.saleLocation ||
    task.customer?.address ||
    'Location not set'
  );
}

function serviceCount(task: AuctionManagementTaskPayload) {
  return task.serviceCatalog.reduce((count, catalog) => count + (catalog.services?.length || 0), 0);
}

function statusLabel(status?: string | null) {
  if (status === 'in_progress') return 'New';
  if (status === 'completed') return 'Completed';
  return 'Incoming';
}

export default function AuctionManagementScreen({ onOpenDrawer }: AuctionManagementScreenProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [activeTab, setActiveTab] = useState<AuctionManagementTaskStatus>('incoming');
  const [tasks, setTasks] = useState<AuctionManagementTaskPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTask, setSelectedTask] = useState<AuctionManagementTaskPayload | null>(null);
  const [formVisible, setFormVisible] = useState(false);

  const activeTabConfig = useMemo(() => TABS.find((tab) => tab.key === activeTab) || TABS[0], [activeTab]);

  const loadTasks = useCallback(async (status: AuctionManagementTaskStatus = activeTab, showSpinner = true) => {
    if (showSpinner) setLoading(true);
    try {
      setTasks(await auctionManagementService.getTasks(status));
    } catch (error: any) {
      Alert.alert('Auction Management', error?.message || 'Failed to load contract tasks.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab]);

  useEffect(() => {
    void loadTasks(activeTab, true);
  }, [activeTab, loadTasks]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void loadTasks(activeTab, false);
  }, [activeTab, loadTasks]);

  const openTask = useCallback(async (task: AuctionManagementTaskPayload) => {
    try {
      const nextTask =
        task.task.status === 'completed'
          ? await auctionManagementService.getTask(task.task.rowGuid)
          : await auctionManagementService.markOpened(task.task.rowGuid);
      setSelectedTask(nextTask);
      setFormVisible(true);
    } catch (error: any) {
      Alert.alert('Auction Management', error?.message || 'Failed to open contract task.');
    }
  }, []);

  const handleFormClose = useCallback(() => {
    setFormVisible(false);
    setSelectedTask(null);
  }, []);

  const handleFormSuccess = useCallback(() => {
    handleFormClose();
    void loadTasks(activeTab, false);
  }, [activeTab, handleFormClose, loadTasks]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={onOpenDrawer}>
          <Feather name="menu" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerEyebrow}>Asset Insight</Text>
          <Text style={styles.headerTitle}>Auction Management System</Text>
        </View>
        <TouchableOpacity style={styles.iconButton} onPress={refresh}>
          <Feather name="refresh-cw" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabButton, active && styles.tabButtonActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.86}>
              <Feather name={tab.icon as any} size={14} color={active ? colors.accentText : colors.textSecondary} />
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} />}>
        <View style={styles.summaryBar}>
          <View>
            <Text style={styles.summaryTitle}>{activeTabConfig.label} contracts</Text>
            <Text style={styles.summaryText}>
              {activeTab === 'incoming'
                ? 'Contracts sent from Auctionsoft for mobile lot capture.'
                : activeTab === 'in_progress'
                  ? 'Opened work that can continue through Lot Listing.'
                  : 'Closed Auction Management contract tasks.'}
            </Text>
          </View>
          <View style={styles.summaryCount}>
            <Text style={styles.summaryCountText}>{tasks.length}</Text>
          </View>
        </View>

        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : tasks.length === 0 ? (
          <View style={styles.emptyCard}>
            <Image source={emptyImage} style={styles.emptyImage} resizeMode="cover" />
            <View style={styles.emptyIcon}>
              <Feather name={activeTabConfig.icon as any} size={26} color={colors.success} />
            </View>
            <Text style={styles.emptyTitle}>All clear!</Text>
            <Text style={styles.emptyText}>
              {activeTab === 'incoming'
                ? 'No contracts are waiting for lot listing. Auctionsoft sends work here automatically.'
                : activeTab === 'in_progress'
                  ? 'No Auction Management drafts are in progress.'
                  : 'No completed contracts yet.'}
            </Text>
            <View style={styles.flowRow}>
              <Text style={styles.flowMuted}>Auctionsoft</Text>
              <Text style={styles.flowActive}>Mobile capture</Text>
              <Text style={styles.flowMuted}>Lotting / Op To-Do</Text>
            </View>
          </View>
        ) : (
          tasks.map((task) => {
            const services = serviceCount(task);
            return (
              <TouchableOpacity
                key={task.task.rowGuid}
                style={styles.taskCard}
                onPress={() => openTask(task)}
                activeOpacity={0.88}>
                <View style={styles.taskTopRow}>
                  <View style={styles.taskIconWrap}>
                    <Feather name="file-text" size={20} color={colors.accent} />
                  </View>
                  <View style={styles.taskBody}>
                    <View style={styles.taskTitleRow}>
                      <Text style={styles.taskTitle} numberOfLines={1}>{taskTitle(task)}</Text>
                      <View style={styles.statusChip}>
                        <Text style={styles.statusChipText}>{statusLabel(task.task.status)}</Text>
                      </View>
                    </View>
                    <Text style={styles.taskMeta} numberOfLines={1}>{customerName(task)}</Text>
                    <Text style={styles.taskMeta} numberOfLines={1}>{locationLabel(task)}</Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={colors.textMuted} />
                </View>

                <View style={styles.taskFooter}>
                  <View style={styles.taskMetric}>
                    <Feather name="layers" size={13} color={colors.accent} />
                    <Text style={styles.taskMetricText}>{task.lots.length} lot{task.lots.length === 1 ? '' : 's'}</Text>
                  </View>
                  <View style={styles.taskMetric}>
                    <Feather name="tool" size={13} color={colors.accent} />
                    <Text style={styles.taskMetricText}>{services} services</Text>
                  </View>
                  {task.event?.eventDate ? (
                    <View style={styles.taskMetric}>
                      <Feather name="calendar" size={13} color={colors.accent} />
                      <Text style={styles.taskMetricText}>{formatDate(task.event.eventDate)}</Text>
                    </View>
                  ) : null}
                </View>

                {task.task.lastError ? (
                  <Text style={styles.errorText} numberOfLines={2}>{task.task.lastError}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <LotListingFormSheet
        visible={formVisible}
        onClose={handleFormClose}
        onSuccess={handleFormSuccess}
        auctionManagementTask={selectedTask}
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 9,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: {
    flex: 1,
    marginLeft: 12,
  },
  headerEyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  headerTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '900',
    marginTop: 2,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.background,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  tabButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabButtonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
  },
  tabTextActive: {
    color: colors.accentText,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    paddingBottom: 32,
    width: '100%',
    maxWidth: 920,
    alignSelf: 'center',
  },
  summaryBar: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: colors.text,
  },
  summaryText: {
    maxWidth: 250,
    marginTop: 3,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
  },
  summaryCount: {
    width: 42,
    height: 42,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryCountText: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '900',
  },
  centerState: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderRadius: 10,
    alignItems: 'center',
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  emptyImage: {
    width: '100%',
    height: 150,
  },
  emptyIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -25,
    marginBottom: 12,
    borderWidth: 3,
    borderColor: colors.surface,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: colors.text,
  },
  emptyText: {
    marginTop: 8,
    paddingHorizontal: 22,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
    textAlign: 'center',
  },
  flowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 22,
    paddingHorizontal: 18,
    gap: 10,
  },
  flowMuted: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },
  flowActive: {
    flex: 1,
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    textAlign: 'center',
  },
  taskCard: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  taskTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  taskIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  taskBody: {
    flex: 1,
  },
  taskTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  taskTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '900',
    color: colors.text,
  },
  taskMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  statusChip: {
    borderRadius: 8,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusChipText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
  },
  taskFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  taskMetric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  taskMetricText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '800',
  },
  errorText: {
    marginTop: 10,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 17,
  },
});
