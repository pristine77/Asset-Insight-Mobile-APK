import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UploadContinuationPanel from '../UploadContinuationPanel';
import durableContinuationService from '../../services/durableContinuationService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import auctioneerService, {
  type AuctioneerIncomingItem,
  type AuctioneerReportType,
  type AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';
import AssetFormSheet from '../forms/AssetFormSheet';
import LotListingFormSheet from '../forms/LotListingFormSheet';

interface Props {
  refreshVersion?: number;
  onOpenReport: (reportId: string, reportType: AuctioneerReportType) => void;
}

/** Modern assigned contracts stay separate from legacy Auctionsoft task IDs. */
export default function AuctioneerIncoming({ refreshVersion = 0, onOpenReport }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [items, setItems] = useState<AuctioneerIncomingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [setup, setSetup] = useState<AuctioneerWorkItemSetup | null>(null);
  const [draftId, setDraftId] = useState<string>();
  const readRevision = useRef(0);
  const mounted = useRef(true);
  const claimLock = useRef(false);

  const load = useCallback(async (refresh = false) => {
    const revision = ++readRevision.current;
    setError('');
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const status = await auctioneerService.getStatus();
      if (!mounted.current || revision !== readRevision.current) return;
      const available = status.enabled && status.configured;
      setEnabled(available);
      if (!available) {
        setItems([]);
        return;
      }
      const next = await auctioneerService.getIncoming(refresh);
      if (mounted.current && revision === readRevision.current) setItems(next);
    } catch (cause) {
      if (mounted.current && revision === readRevision.current) {
        setError(
          cause instanceof Error ? cause.message : 'Could not load assigned contracts. Try again.'
        );
      }
    } finally {
      if (mounted.current && revision === readRevision.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(refreshVersion > 0);
    return () => {
      mounted.current = false;
      readRevision.current += 1;
    };
  }, [load, refreshVersion]);

  const open = useCallback(
    async (item: AuctioneerIncomingItem, reportType: AuctioneerReportType) => {
      if (claimLock.current || (item.status !== 'available' && !item.claimedByMe)) return;
      claimLock.current = true;
      const owner = OfflineCaptureStore.getOwnerId();
      setOpening(item.cycleKey);
      setError('');
      try {
        const next = item.workItemId
          ? await auctioneerService.getSetup(item.workItemId)
          : await auctioneerService.claim(item.cycleKey, reportType);
        if (!mounted.current || OfflineCaptureStore.getOwnerId() !== owner) return;
        if (next.reportId) onOpenReport(next.reportId, next.reportType);
        else {
          const savedDraft = owner ? await durableContinuationService.successorDraft(next.workItemId) : undefined;
          if (!mounted.current || OfflineCaptureStore.getOwnerId() !== owner) return;
          setDraftId(savedDraft); setSetup(next); // The boundary rechecks claimed/unused state.
        }
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not open this contract. Refresh Incoming and try again.'
          );
      } finally {
        claimLock.current = false;
        if (mounted.current) setOpening(null);
      }
    },
    [onOpenReport]
  );

  const close = useCallback(() => {
    setSetup(null);
    setDraftId(undefined);
    void load(true);
  }, [load]);
  const nextForm = useCallback(
    (next: AuctioneerWorkItemSetup) => {
      setSetup(next);
      void load(true);
    },
    [load]
  );

  const renderItem = useCallback(
    ({ item }: { item: AuctioneerIncomingItem }) => {
      const busy = opening !== null;
      const claimedElsewhere = item.status !== 'available' && !item.claimedByMe;
      return (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.title}>Contract {item.contractNo}</Text>
            {opening === item.cycleKey && (
              <ActivityIndicator accessibilityLabel="Opening contract" color={colors.accent} />
            )}
          </View>
          {!!item.customerName && <Text style={styles.meta}>{item.customerName}</Text>}
          {!!item.eventTitle && <Text style={styles.meta}>{item.eventTitle}</Text>}
          {!!item.location && <Text style={styles.meta}>{item.location}</Text>}
          <Text style={styles.meta}>
            {item.kind === 'scheduleA' ? `${item.lotCount} imported lots` : 'New lot capture'}
          </Text>
          {claimedElsewhere ? (
            <Text style={styles.meta}>This work is not available to open.</Text>
          ) : (
            <View style={styles.actions}>
              {item.status === 'available' ? (
                (['asset', 'lotListing'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    accessibilityRole="button"
                    accessibilityLabel={`Open contract ${item.contractNo} as ${type === 'asset' ? 'Asset' : 'Lot Listing'}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    style={[styles.button, busy && styles.disabled]}
                    onPress={() => void open(item, type)}>
                    <Text style={styles.buttonText}>
                      {type === 'asset' ? 'Asset Listing' : 'Lot Listing'}
                    </Text>
                  </TouchableOpacity>
                ))
              ) : (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Open contract ${item.contractNo}`}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  style={[styles.button, busy && styles.disabled]}
                  onPress={() => void open(item, item.selectedReportType || 'asset')}>
                  <Text style={styles.buttonText}>
                    {item.status === 'claimed' ? 'Continue capture' : 'View report'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      );
    },
    [colors.accent, open, opening, styles]
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={enabled ? items : []}
        keyExtractor={(item) => item.workItemId || item.cycleKey}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        initialNumToRender={8}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          <View style={styles.intro}>
            <Text style={styles.heading}>Auctioneer 2.0 · Assigned contracts</Text>
            <Text style={styles.meta}>
              Open an Asset or Lot Listing. Generate files & new lot keeps this contract for your
              next report.
            </Text>
            {!!error && (
              <View accessibilityLiveRegion="polite" style={styles.error}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Retry assigned contracts"
                  style={styles.retry}
                  onPress={() => void load(true)}>
                  <Text style={styles.buttonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            <UploadContinuationPanel onOpen={(id, _type, next) => { setDraftId(id); setSetup(next); }} />
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator
              accessibilityLabel="Loading assigned contracts"
              color={colors.accent}
            />
          ) : !error ? (
            <Text style={styles.meta}>
              {enabled
                ? 'No assigned contracts are waiting. Pull down to refresh.'
                : 'Auctioneer 2.0 is not enabled or configured on the server. Legacy Auctionsoft tasks remain available.'}
            </Text>
          ) : null
        }
      />
      {setup?.reportType === 'asset' && (
        <AssetFormSheet
          visible
          onClose={close}
          onSuccess={close}
          auctioneer={setup}
          draftIdToLoad={draftId}
          onAuctioneerSetupChange={nextForm}
        />
      )}
      {setup?.reportType === 'lotListing' && (
        <LotListingFormSheet
          visible
          onClose={close}
          onSuccess={close}
          auctioneer={setup}
          draftIdToLoad={draftId}
          onAuctioneerSetupChange={nextForm}
        />
      )}
    </View>
  );
}

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 32, width: '100%', maxWidth: 920, alignSelf: 'center' },
    intro: { gap: 8, marginBottom: 16 },
    heading: { fontSize: 17, fontWeight: '700', color: colors.text },
    card: {
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      marginBottom: 12,
      gap: 6,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text },
    meta: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    button: {
      flexGrow: 1,
      minWidth: 116,
      minHeight: 44,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
    buttonText: { fontSize: 13, fontWeight: '700', color: colors.accentText, textAlign: 'center' },
    disabled: { opacity: 0.55 },
    error: { padding: 12, backgroundColor: colors.dangerSoft, borderRadius: 8, gap: 10 },
    errorText: { color: colors.danger, fontSize: 13, lineHeight: 20 },
    retry: {
      alignSelf: 'flex-start',
      minHeight: 44,
      justifyContent: 'center',
      padding: 12,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
  });
