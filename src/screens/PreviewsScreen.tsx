import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import api from '../services/api';
import { assetService } from '../services/assetService';
import AssetMergeSheet from '../components/AssetMergeSheet';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';

type ReportType = 'Asset' | 'RealEstate' | 'LotListing';
type PreviewMode = 'pending' | 'submitted';

type PreviewItem = {
  id: string;
  type: ReportType;
  status: string;
  title: string;
  createdAt: string;
  generationState?: 'queued' | 'processing' | 'ready' | 'error';
  workflowStage?: string;
  workflowMessage?: string;
  workflowProgressPercent?: number;
  generationProgress?: {
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
  };
  jobError?: string;
  wasSubmitted: boolean;
  wasTransferred?: boolean;
  isMergedReport?: boolean;
  mergedSourceCount?: number;
};

interface PreviewsScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  onOpenPreview: (reportId: string, reportType: ReportType, mode: PreviewMode) => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  initialMode?: PreviewMode;
}

type BadgeConfig = { bg: string; text: string; label: string; icon: keyof typeof Feather.glyphMap };

const PreviewsScreen = ({
  onOpenDrawer,
  onBack,
  onOpenPreview,
  unreadCount = 0,
  onOpenNotifications,
  initialMode = 'pending',
}: PreviewsScreenProps) => {
  const { width } = useWindowDimensions();
  const isTablet = width >= 760;
  const { isDark, colors, toggleTheme } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, isTablet), [colors, isTablet]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<PreviewMode>(initialMode);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [mergeAnchorId, setMergeAnchorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      setLoadError(null);
      const [assetReports, realEstateResponse, lotListingResponse] = await Promise.all([
        assetService.getAssetReports(),
        api.get('/real-estate'),
        api.get('/lot-listing').catch(() => ({ data: { data: [] } })),
      ]);

      const next: PreviewItem[] = [];
      const realEstateReports = realEstateResponse.data?.data || [];
      const lotListingReports = lotListingResponse.data?.data || [];

      for (const report of assetReports) {
        if (!report?._id) continue;
        if (!['processing', 'error', 'preview', 'declined', 'pending_approval', 'approved'].includes(report.status)) continue;
        const previewData = report.preview_data || {};
        next.push({
          id: report._id,
          type: 'Asset',
          status: report.status,
          title: previewData?.client_name || 'Asset Report',
          createdAt: report.createdAt,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          generationProgress: report.generation_progress,
          jobError: report.job_error,
          wasSubmitted: Boolean(
            report.status === 'pending_approval' ||
              report.status === 'approved' ||
              (report as any).preview_submitted_at ||
              (report as any).approval_requested_at
          ),
          wasTransferred: Boolean(report.preview_transferred_at),
          isMergedReport: report.is_merged_report === true,
          mergedSourceCount: Array.isArray(report.merged_from_report_ids)
            ? report.merged_from_report_ids.length
            : 0,
        });
      }

      for (const report of realEstateReports) {
        if (!report?._id) continue;
        if (!['processing', 'error', 'preview', 'declined', 'pending_approval', 'approved'].includes(report.status)) continue;
        if (report.status === 'approved' && report.files_ready === true) continue;
        next.push({
          id: report._id,
          type: 'RealEstate',
          status: report.status,
          title:
            report.property_details?.address ||
            report.preview_data?.property_details?.address ||
            report.property_details?.owner_name ||
            'Real Estate Report',
          createdAt: report.createdAt,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          generationProgress: report.generation_progress,
          jobError: report.job_error,
          wasSubmitted: Boolean(
            report.status === 'pending_approval' ||
              report.status === 'approved' ||
              report.preview_submitted_at ||
              report.approval_requested_at
          ),
        });
      }

      for (const report of lotListingReports) {
        if (!report?._id) continue;
        if (!['processing', 'error', 'preview', 'declined', 'pending_approval', 'approved'].includes(report.status)) continue;
        const previewData = report.preview_data || {};
        const contractNo = previewData.contract_no || report.contract_no || 'Lot Listing';
        const location = previewData.location || report.location || '';
        next.push({
          id: report._id,
          type: 'LotListing',
          status: report.status,
          title: `${contractNo}${location ? ` - ${location}` : ''}`,
          createdAt: report.createdAt,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          generationProgress: report.generation_progress,
          jobError: report.job_error,
          wasSubmitted: Boolean(
            report.status === 'pending_approval' ||
              report.status === 'approved' ||
              report.preview_submitted_at ||
              report.approval_requested_at ||
              report.generation_target_status === 'approved' ||
              report.generation_target_status === 'pending_approval'
          ),
          wasTransferred: Boolean(report.preview_transferred_at),
        });
      }

      next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setItems(next);
    } catch (error) {
      console.error('[Previews] Failed to fetch:', error);
      setLoadError('Previews could not be loaded. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void fetchItems();
      }
    });
    return () => subscription.remove();
  }, [fetchItems]);

  const pendingItems = useMemo(
    () => items.filter((item) => !item.wasSubmitted && ['processing', 'error', 'preview', 'declined'].includes(item.status)),
    [items]
  );
  const submittedItems = useMemo(
    () => items.filter((item) => item.wasSubmitted),
    [items]
  );
  const visibleItems = activeTab === 'pending' ? pendingItems : submittedItems;
  const activeJobCount = items.filter(
    (item) =>
      item.workflowStage === 'preparing_preview' ||
      item.workflowStage === 'generating_files' ||
      item.generationState === 'queued' ||
      item.generationState === 'processing'
  ).length;

  useEffect(() => {
    if (activeJobCount === 0) return;
    const interval = setInterval(() => void fetchItems(), 10_000);
    return () => clearInterval(interval);
  }, [activeJobCount, fetchItems]);

  useEffect(() => {
    if (activeJobCount > 0) return;
    const interval = setInterval(() => void fetchItems(), 60_000);
    return () => clearInterval(interval);
  }, [activeJobCount, fetchItems]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchItems();
  }, [fetchItems]);

  const getStatusBadge = useCallback(
    (item: PreviewItem): BadgeConfig => {
      const workflowBadges: Record<string, BadgeConfig> = {
        preparing_preview: { bg: colors.infoSoft, text: colors.info, label: 'Preparing preview', icon: 'loader' },
        preview_ready: { bg: colors.infoSoft, text: colors.info, label: 'Preview ready', icon: 'eye' },
        generating_files: { bg: colors.infoSoft, text: colors.info, label: 'Generating files', icon: 'loader' },
        awaiting_approval: { bg: colors.warningSoft, text: colors.warning, label: 'Awaiting approval', icon: 'clock' },
        awaiting_release: { bg: colors.warningSoft, text: colors.warning, label: 'Awaiting release', icon: 'clock' },
        ready: { bg: colors.successSoft, text: colors.success, label: 'Ready to download', icon: 'check-circle' },
        error: { bg: colors.dangerSoft, text: colors.danger, label: 'Generation failed', icon: 'alert-circle' },
      };
      if (item.workflowStage && workflowBadges[item.workflowStage]) {
        return workflowBadges[item.workflowStage];
      }
      if (item.generationState === 'error') {
        return { bg: colors.dangerSoft, text: colors.danger, label: 'Action required', icon: 'alert-circle' };
      }
      if (item.generationState === 'queued') {
        return { bg: colors.infoSoft, text: colors.info, label: 'Queued', icon: 'clock' };
      }
      if (item.generationState === 'processing') {
        return { bg: colors.infoSoft, text: colors.info, label: 'Processing', icon: 'loader' };
      }
      if (item.status === 'approved') {
        return { bg: colors.successSoft, text: colors.success, label: 'Approved', icon: 'check-circle' };
      }
      if (item.status === 'pending_approval') {
        return { bg: colors.warningSoft, text: colors.warning, label: 'Pending approval', icon: 'clock' };
      }
      if (item.status === 'declined') {
        return { bg: colors.dangerSoft, text: colors.danger, label: 'Declined', icon: 'x-circle' };
      }
      return { bg: colors.accentSoft, text: colors.accent, label: 'Ready to review', icon: 'eye' };
    },
    [colors]
  );

  const getTypeBadge = useCallback(
    (type: ReportType): BadgeConfig => {
      if (type === 'RealEstate') {
        return { bg: colors.successSoft, text: colors.success, label: 'Real Estate', icon: 'home' };
      }
      if (type === 'LotListing') {
        return { bg: isDark ? '#2B1D48' : '#F3EFFF', text: isDark ? '#C4A7FF' : '#6D28D9', label: 'Lot Listing', icon: 'list' };
      }
      return { bg: colors.accentSoft, text: colors.accent, label: 'Asset', icon: 'package' };
    },
    [colors, isDark]
  );

  const handleQuickResubmit = useCallback(
    (item: PreviewItem) => {
      Alert.alert(
        'Resend report',
        'This regenerates the latest files and resends the report for approval.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Resend',
            onPress: async () => {
              try {
                let endpoint = `/asset/${item.id}/resubmit`;
                if (item.type === 'RealEstate') endpoint = `/real-estate/${item.id}/resubmit`;
                if (item.type === 'LotListing') endpoint = `/lot-listing/${item.id}/resubmit`;
                await api.post(endpoint);
                Alert.alert('Resubmitted', 'Updated files are now being generated.');
                void fetchItems();
              } catch (error: any) {
                Alert.alert('Unable to resubmit', error.response?.data?.message || 'Please try again.');
              }
            },
          },
        ]
      );
    },
    [fetchItems]
  );

  const handleDelete = useCallback(
    (item: PreviewItem) => {
      Alert.alert('Delete preview', 'This preview and its saved data will be permanently deleted.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              let endpoint = `/asset/${item.id}`;
              if (item.type === 'RealEstate') endpoint = `/real-estate/${item.id}`;
              if (item.type === 'LotListing') endpoint = `/lot-listing/${item.id}`;
              await api.delete(endpoint);
              void fetchItems();
            } catch (error: any) {
              Alert.alert('Unable to delete', error.response?.data?.message || 'Please try again.');
            }
          },
        },
      ]);
    },
    [fetchItems]
  );

  const renderItem = useCallback(
    ({ item }: { item: PreviewItem }) => {
      const statusBadge = getStatusBadge(item);
      const typeBadge = getTypeBadge(item.type);
      const isDeclined = item.status === 'declined';
      const isJobActive =
        item.workflowStage === 'preparing_preview' ||
        item.workflowStage === 'generating_files' ||
        item.generationState === 'queued' ||
        item.generationState === 'processing';
      const progress = Math.max(0, Math.min(100, Number(
        item.workflowProgressPercent ?? item.generationProgress?.progressPercent ?? 0
      )));

      return (
        <View style={[styles.card, { borderLeftColor: statusBadge.text }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.typeIcon, { backgroundColor: typeBadge.bg }]}>
              <Feather name={typeBadge.icon} size={20} color={typeBadge.text} />
            </View>
            <View style={styles.cardTitleWrap}>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.cardDate}>
                {new Date(item.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: statusBadge.bg }]}>
              <Feather name={statusBadge.icon} size={12} color={statusBadge.text} />
              <Text style={[styles.statusBadgeText, { color: statusBadge.text }]}>{statusBadge.label}</Text>
            </View>
          </View>

          <View style={styles.metadataRow}>
            <View style={styles.metadataItem}>
              <Text style={styles.metadataLabel}>TYPE</Text>
              <Text style={[styles.metadataValue, { color: typeBadge.text }]}>{typeBadge.label}</Text>
            </View>
            <View style={styles.metadataDivider} />
            <View style={styles.metadataItem}>
              <Text style={styles.metadataLabel}>QUEUE</Text>
              <Text style={styles.metadataValue}>{item.wasSubmitted ? 'Submitted' : 'New preview'}</Text>
            </View>
            {item.isMergedReport ? (
              <>
                <View style={styles.metadataDivider} />
                <View style={styles.metadataItem}>
                  <Text style={styles.metadataLabel}>MERGED</Text>
                  <Text style={styles.metadataValue}>{item.mergedSourceCount || 2} sources</Text>
                </View>
              </>
            ) : null}
            {item.wasTransferred ? (
              <>
                <View style={styles.metadataDivider} />
                <View style={styles.metadataItem}>
                  <Text style={styles.metadataLabel}>ASSIGNED</Text>
                  <Text style={styles.metadataValue}>By admin</Text>
                </View>
              </>
            ) : null}
          </View>

          {isJobActive ? (
            <View style={styles.progressPanel}>
              <View style={styles.progressHeader}>
                <View style={styles.progressCopy}>
                  <ActivityIndicator size="small" color={colors.info} />
                  <Text style={styles.progressMessage} numberOfLines={1}>
                    {item.workflowMessage || item.generationProgress?.message || 'Processing report'}
                  </Text>
                </View>
                <Text style={styles.progressPercent}>{Math.round(progress)}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(3, progress)}%` }]} />
              </View>
              {item.generationProgress?.totalLots ? (
                <Text style={styles.progressLotText}>
                  Lot {item.generationProgress.currentLot || 0} of {item.generationProgress.totalLots}
                </Text>
              ) : null}
            </View>
          ) : item.workflowStage === 'error' || item.generationState === 'error' ? (
            <View style={styles.errorPanel}>
              <Feather name="alert-triangle" size={16} color={colors.danger} />
              <Text style={styles.errorText} numberOfLines={3}>
                {item.jobError || 'Report processing failed. Open the report to review the issue.'}
              </Text>
            </View>
          ) : null}

          {activeTab === 'pending' ? (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.primaryButton, isDeclined && styles.declinedButton]}
                activeOpacity={0.78}
                onPress={() => onOpenPreview(item.id, item.type, 'pending')}>
                <Feather name={isDeclined ? 'rotate-ccw' : 'edit-3'} size={16} color="#FFFFFF" />
                <Text style={styles.primaryButtonText}>{isDeclined ? 'Edit & resubmit' : 'Review & submit'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconDangerButton}
                activeOpacity={0.75}
                onPress={() => handleDelete(item)}>
                <Feather name="trash-2" size={17} color={colors.danger} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.actionRow}>
              {isJobActive ? (
                <View style={styles.busyButton}>
                  <ActivityIndicator size="small" color={colors.info} />
                  <Text style={styles.busyButtonText}>
                    {item.workflowStage === 'preparing_preview' ? 'Preparing preview' : 'Generating files'}
                  </Text>
                </View>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    activeOpacity={0.75}
                    onPress={() => onOpenPreview(item.id, item.type, 'submitted')}>
                    <Feather name="edit-2" size={15} color={colors.text} />
                    <Text style={styles.secondaryButtonText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    activeOpacity={0.75}
                    onPress={() => handleQuickResubmit(item)}>
                    <Feather name="refresh-cw" size={15} color={colors.text} />
                    <Text style={styles.secondaryButtonText}>Resend</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                style={styles.iconDangerButton}
                activeOpacity={0.75}
                onPress={() => handleDelete(item)}>
                <Feather name="trash-2" size={17} color={colors.danger} />
              </TouchableOpacity>
            </View>
          )}

          {item.type === 'Asset' && !isJobActive ? (
            <TouchableOpacity
              style={styles.mergeButton}
              activeOpacity={0.75}
              onPress={() => setMergeAnchorId(item.id)}>
              <Feather name="git-merge" size={15} color={colors.info} />
              <Text style={styles.mergeButtonText}>Merge same-contract Asset reports</Text>
              <Feather name="chevron-right" size={16} color={colors.info} />
            </TouchableOpacity>
          ) : null}
        </View>
      );
    },
    [
      activeTab,
      colors,
      getStatusBadge,
      getTypeBadge,
      handleDelete,
      handleQuickResubmit,
      onOpenPreview,
      styles,
    ]
  );

  const header = (
    <>
      <View style={styles.commandHeader}>
        <View style={styles.headerToolbar}>
          <TouchableOpacity onPress={onOpenDrawer} style={styles.headerIconButton} activeOpacity={0.75}>
            <Feather name="menu" size={21} color="#FFFFFF" />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle}>Previews</Text>
            <Text style={styles.headerSubtitle}>Review, submit, and track report generation</Text>
          </View>
          <TouchableOpacity onPress={toggleTheme} style={styles.headerIconButton} activeOpacity={0.75}>
            <Feather name={isDark ? 'sun' : 'moon'} size={18} color="#FFFFFF" />
          </TouchableOpacity>
          {onOpenNotifications ? (
            <TouchableOpacity onPress={onOpenNotifications} style={styles.headerIconButton} activeOpacity={0.75}>
              <Feather name="bell" size={18} color="#FFFFFF" />
              {unreadCount > 0 ? (
                <View style={styles.notificationDot}>
                  <Text style={styles.notificationDotText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.queueSummary}>
          <View style={styles.queueSummaryItem}>
            <Text style={styles.queueSummaryValue}>{pendingItems.length}</Text>
            <Text style={styles.queueSummaryLabel}>New previews</Text>
          </View>
          <View style={styles.queueSummaryDivider} />
          <View style={styles.queueSummaryItem}>
            <Text style={styles.queueSummaryValue}>{submittedItems.length}</Text>
            <Text style={styles.queueSummaryLabel}>Submitted</Text>
          </View>
          <View style={styles.queueSummaryDivider} />
          <View style={styles.queueSummaryItem}>
            <Text style={[styles.queueSummaryValue, activeJobCount > 0 && { color: '#78A7FF' }]}>
              {activeJobCount}
            </Text>
            <Text style={styles.queueSummaryLabel}>Processing</Text>
          </View>
        </View>
      </View>

      <View style={styles.utilityRow}>
        <TouchableOpacity onPress={onBack} style={styles.backButton} activeOpacity={0.75}>
          <Feather name="arrow-left" size={16} color={colors.textSecondary} />
          <Text style={styles.backButtonText}>Dashboard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onRefresh}
          disabled={refreshing || loading}
          style={styles.refreshButton}
          activeOpacity={0.75}>
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Feather name="refresh-cw" size={16} color={colors.textSecondary} />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.segmentedControl}>
        <TouchableOpacity
          style={[styles.segment, activeTab === 'pending' && styles.segmentActive]}
          activeOpacity={0.8}
          onPress={() => setActiveTab('pending')}>
          <Text style={[styles.segmentText, activeTab === 'pending' && styles.segmentTextActive]}>New</Text>
          <View style={[styles.segmentCount, activeTab === 'pending' && styles.segmentCountActive]}>
            <Text style={[styles.segmentCountText, activeTab === 'pending' && styles.segmentCountTextActive]}>
              {pendingItems.length}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segment, activeTab === 'submitted' && styles.segmentActive]}
          activeOpacity={0.8}
          onPress={() => setActiveTab('submitted')}>
          <Text style={[styles.segmentText, activeTab === 'submitted' && styles.segmentTextActive]}>Submitted</Text>
          <View style={[styles.segmentCount, activeTab === 'submitted' && styles.segmentCountActive]}>
            <Text style={[styles.segmentCountText, activeTab === 'submitted' && styles.segmentCountTextActive]}>
              {submittedItems.length}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {loadError ? (
        <View style={styles.loadErrorPanel}>
          <Feather name="wifi-off" size={17} color={colors.danger} />
          <Text style={styles.loadErrorText}>{loadError}</Text>
          <TouchableOpacity onPress={onRefresh} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {loading ? (
        <View style={styles.loadingScreen}>
          {header}
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.loadingText}>Loading previews...</Text>
          </View>
        </View>
      ) : (
        <FlatList
          key={isTablet ? 'tablet-previews' : 'phone-previews'}
          data={visibleItems}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          numColumns={isTablet ? 2 : 1}
          columnWrapperStyle={isTablet ? styles.columnWrapper : undefined}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <Feather name={activeTab === 'pending' ? 'inbox' : 'send'} size={25} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>
                {activeTab === 'pending' ? 'No new previews' : 'No submitted previews'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {activeTab === 'pending'
                  ? 'New report previews and processing updates will appear here.'
                  : 'Reports move here as soon as they are submitted.'}
              </Text>
            </View>
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
              progressBackgroundColor={colors.surface}
            />
          }
        />
      )}

      <AssetMergeSheet
        visible={Boolean(mergeAnchorId)}
        anchorReportId={mergeAnchorId}
        onClose={() => setMergeAnchorId(null)}
        onCreated={() => {
          setMergeAnchorId(null);
          setActiveTab('pending');
          void fetchItems();
        }}
      />
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors, isTablet: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    loadingScreen: { flex: 1, backgroundColor: colors.background },
    listContent: {
      paddingHorizontal: isTablet ? 24 : 14,
      paddingTop: 12,
      paddingBottom: 32,
      maxWidth: 1100,
      width: '100%',
      alignSelf: 'center',
    },
    commandHeader: {
      backgroundColor: colors.graphite,
      borderRadius: 12,
      padding: isTablet ? 20 : 15,
      marginBottom: 12,
      borderBottomWidth: 4,
      borderBottomColor: colors.accent,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.25,
      shadowRadius: 18,
      elevation: 11,
    },
    headerToolbar: { flexDirection: 'row', alignItems: 'center' },
    headerIconButton: {
      width: 39,
      height: 39,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.graphiteSoft,
      borderWidth: 1,
      borderColor: '#353B45',
      marginLeft: 7,
    },
    headerTitleWrap: { flex: 1, marginLeft: 12, minWidth: 0 },
    headerTitle: { color: '#FFFFFF', fontSize: 21, fontWeight: '900' },
    headerSubtitle: { color: '#AEB7C4', fontSize: 11.5, marginTop: 2 },
    notificationDot: {
      position: 'absolute',
      top: -5,
      right: -5,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.graphite,
      alignItems: 'center',
      justifyContent: 'center',
    },
    notificationDotText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900' },
    queueSummary: {
      marginTop: 18,
      minHeight: 62,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#0B0D10',
      borderRadius: 9,
      borderWidth: 1,
      borderColor: '#2A3038',
    },
    queueSummaryItem: { flex: 1, alignItems: 'center' },
    queueSummaryValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
    queueSummaryLabel: { color: '#96A1B1', fontSize: 9.5, fontWeight: '700', marginTop: 2 },
    queueSummaryDivider: { height: 30, width: 1, backgroundColor: '#303640' },
    utilityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    backButton: {
      height: 38,
      paddingHorizontal: 11,
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    backButtonText: { color: colors.textSecondary, fontSize: 12, fontWeight: '800' },
    refreshButton: {
      width: 38,
      height: 38,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    segmentedControl: {
      flexDirection: 'row',
      padding: 4,
      borderRadius: 10,
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 14,
    },
    segment: {
      flex: 1,
      minHeight: 42,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 7,
    },
    segmentActive: {
      backgroundColor: colors.surfaceRaised,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 6,
      elevation: 3,
    },
    segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: '800' },
    segmentTextActive: { color: colors.text },
    segmentCount: {
      minWidth: 24,
      height: 22,
      borderRadius: 7,
      paddingHorizontal: 6,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.borderStrong,
    },
    segmentCountActive: { backgroundColor: colors.accent },
    segmentCountText: { color: colors.textSecondary, fontSize: 10, fontWeight: '900' },
    segmentCountTextActive: { color: '#FFFFFF' },
    loadErrorPanel: {
      minHeight: 54,
      padding: 11,
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.dangerSoft,
      borderWidth: 1,
      borderColor: colors.danger,
      marginBottom: 12,
    },
    loadErrorText: { flex: 1, color: colors.danger, fontSize: 11.5, lineHeight: 16, fontWeight: '600' },
    retryButton: { paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7, backgroundColor: colors.danger },
    retryButtonText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '900' },
    columnWrapper: { gap: 12 },
    card: {
      flex: 1,
      minWidth: 0,
      backgroundColor: colors.surfaceRaised,
      borderRadius: 11,
      padding: 13,
      marginBottom: 12,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderColor: colors.border,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: 0.11,
      shadowRadius: 11,
      elevation: 5,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    typeIcon: { width: 42, height: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    cardTitleWrap: { flex: 1, minWidth: 0, paddingRight: 8 },
    cardTitle: { color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: '900' },
    cardDate: { color: colors.textMuted, fontSize: 10.5, marginTop: 3 },
    statusBadge: {
      maxWidth: 110,
      minHeight: 28,
      borderRadius: 8,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    statusBadgeText: { fontSize: 9.5, fontWeight: '900', flexShrink: 1 },
    metadataRow: {
      flexDirection: 'row',
      marginTop: 13,
      paddingVertical: 10,
      paddingHorizontal: 9,
      borderRadius: 8,
      backgroundColor: colors.surfaceMuted,
      alignItems: 'center',
    },
    metadataItem: { flex: 1 },
    metadataLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900' },
    metadataValue: { color: colors.textSecondary, fontSize: 10.5, fontWeight: '800', marginTop: 2 },
    metadataDivider: { width: 1, height: 26, backgroundColor: colors.borderStrong, marginHorizontal: 8 },
    progressPanel: { backgroundColor: colors.infoSoft, borderRadius: 8, padding: 10, marginTop: 11 },
    progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    progressCopy: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
    progressMessage: { flex: 1, color: colors.info, fontSize: 11, fontWeight: '800' },
    progressPercent: { color: colors.info, fontSize: 11, fontWeight: '900' },
    progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.borderStrong, marginTop: 8 },
    progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.info },
    progressLotText: { color: colors.textMuted, fontSize: 9.5, marginTop: 6 },
    errorPanel: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'flex-start',
      backgroundColor: colors.dangerSoft,
      borderRadius: 8,
      padding: 10,
      marginTop: 11,
    },
    errorText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 16, fontWeight: '700' },
    actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    primaryButton: {
      flex: 1,
      height: 42,
      borderRadius: 9,
      backgroundColor: colors.accent,
      borderBottomWidth: 3,
      borderBottomColor: colors.accentPressed,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    declinedButton: { backgroundColor: colors.danger, borderBottomColor: '#9F1239' },
    primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
    secondaryButton: {
      flex: 1,
      height: 42,
      borderRadius: 9,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    secondaryButtonText: { color: colors.text, fontSize: 11.5, fontWeight: '900' },
    busyButton: {
      flex: 1,
      height: 42,
      borderRadius: 9,
      backgroundColor: colors.infoSoft,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    busyButtonText: { color: colors.info, fontSize: 11.5, fontWeight: '900' },
    iconDangerButton: {
      width: 42,
      height: 42,
      borderRadius: 9,
      backgroundColor: colors.dangerSoft,
      borderWidth: 1,
      borderColor: colors.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    mergeButton: {
      height: 38,
      marginTop: 9,
      borderRadius: 8,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: colors.infoSoft,
    },
    mergeButtonText: { flex: 1, color: colors.info, fontSize: 10.5, fontWeight: '800' },
    emptyState: {
      minHeight: 250,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 26,
    },
    emptyIcon: { width: 52, height: 52, borderRadius: 11, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 13 },
    emptySubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 5, maxWidth: 300 },
    loadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 10 },
  });

export default PreviewsScreen;
