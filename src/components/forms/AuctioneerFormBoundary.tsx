import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import auctioneerService, { isEditableAuctioneerSetup, validateAuctioneerSuccessor, type AuctioneerReportType, type AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import autoSaveService from '../../services/autoSaveService';
import { acceptedAuctioneerReportId, hasValidAuctioneerLotStructure } from './auctioneerFormPolicy';
import { useAppTheme } from '../../context/ThemeContext';
import NetInfo from '@react-native-community/netinfo';

export interface AuctioneerFormControl {
  setup: AuctioneerWorkItemSetup;
  accepted: boolean;
  restoreDraft: boolean;
  acceptAndContinue: (response: unknown, draftId?: string) => Promise<void>;
}

interface Props {
  visible: boolean;
  type: AuctioneerReportType;
  setup?: AuctioneerWorkItemSetup;
  draftIdToLoad?: string | null;
  onClose: () => void;
  onSetupChange?: (setup: AuctioneerWorkItemSetup) => void;
  children: (control?: AuctioneerFormControl) => React.ReactNode;
}

// The accepted-report gate lives outside the keyed form. A failed handoff keeps
// the original form mounted, and retries can only resolve/continue that report.
export default function AuctioneerFormBoundary(props: Props) {
  const { colors } = useAppTheme();
  const { visible, type, setup, draftIdToLoad, onClose } = props;
  const setupWorkItemId = setup?.workItemId;
  const inputKey = `${setupWorkItemId || ''}:${draftIdToLoad || ''}`;
  const needsResolution = Boolean(setupWorkItemId || draftIdToLoad);
  const [resolved, setResolved] = useState<{ inputKey: string; setup?: AuctioneerWorkItemSetup; resumeUpload?: boolean }>();
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<{ reportId?: string } | null>(null);
  const [usedSuccessor, setUsedSuccessor] = useState<AuctioneerWorkItemSetup | null>(null);
  const acceptedRef = useRef<{ reportId?: string } | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [restoreDraft, setRestoreDraft] = useState(true);
  const acceptedDraftRef = useRef<string | undefined>(undefined);
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    acceptedRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setAccepted(null);
    setUsedSuccessor(null);
    setError('');
    setResolved(undefined);
    setRestoreDraft(true);
    if (!visible || !needsResolution) return;
    void (async () => {
      try {
        const draft = draftIdToLoad ? await autoSaveService.getDraft(draftIdToLoad) : null;
        if (draftIdToLoad && !draft) throw new Error('The requested saved draft is unavailable. Reopen Drafts to select an existing draft; no empty report has been started.');
        const workItemId = setupWorkItemId || draft?.formData.auctioneerWorkItemId;
        if (setupWorkItemId && draft?.formData.auctioneerWorkItemId && draft.formData.auctioneerWorkItemId !== setupWorkItemId) {
          throw new Error('This draft belongs to a different Auctioneer work item.');
        }
        const network = await NetInfo.fetch();
        const offline = network.isConnected === false || network.isInternetReachable === false;
        const cached = draft?.formData.auctioneerSnapshot as AuctioneerWorkItemSetup | undefined;
        if (workItemId && offline && !cached) throw new Error('Connect once to download this Incoming assignment before using it offline. Your local draft has not been changed.');
        const current = workItemId ? offline ? cached : await auctioneerService.getSetup(workItemId) : undefined;
        if (current && (current.workItemId !== workItemId || current.reportType !== type)) throw new Error('The Auctioneer work item or report type does not match this form.');
        if (current && draft && (!hasValidAuctioneerLotStructure(current, draft.lots.map((lot) => ({
          id: lot.id, mode: lot.mode, files: [], extraFiles: [], coverIndex: 0,
        }))) || draft.type !== type || draft.formData.auctioneerWorkItemId !== current.workItemId ||
          draft.formData.contractNo !== current.contract.contractNo || draft.formData.clientSubmissionId !== current.clientSubmissionId)) {
          throw new Error('This draft no longer matches the claimed Auctioneer work item. Reopen Incoming to review it.');
        }
        if (epoch !== epochRef.current) return;
        setResolved({ inputKey, setup: current, resumeUpload: Boolean(current && draft && current.status === 'report_created' && current.canResumeUpload === true) });
      } catch (reason) {
        if (epoch === epochRef.current) setError(reason instanceof Error ? reason.message : 'Unable to validate the Auctioneer draft.');
      }
    })();
    return () => { epochRef.current += 1; };
  }, [visible, inputKey, needsResolution, reload, type, setupWorkItemId, draftIdToLoad]);

  const current = resolved?.inputKey === inputKey ? resolved.setup : undefined;
  const loading = needsResolution && resolved?.inputKey !== inputKey;
  const unavailable = current && !isEditableAuctioneerSetup(current, type) && !resolved?.resumeUpload;
  const renderedEpoch = epochRef.current;

  const continueAccepted = async (response?: unknown, draftId?: string) => {
    if (!current || busyRef.current || renderedEpoch !== epochRef.current) return;
    if (!acceptedRef.current) {
      acceptedDraftRef.current = draftId || draftIdToLoad || undefined;
      acceptedRef.current = { reportId: acceptedAuctioneerReportId(response) || current.reportId || undefined };
      setAccepted(acceptedRef.current);
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    const epoch = epochRef.current;
    try {
      let reportId = acceptedRef.current?.reportId;
      if (!reportId) {
        const observed = await auctioneerService.getSetup(current.workItemId);
        if (observed.canResumeUpload === true) throw new Error('The server has not confirmed upload acceptance yet. Keep the original draft; retry this check before starting a new lot.');
        reportId = observed.reportId || undefined;
        if (!reportId) throw new Error('The upload was accepted, but its report ID is not available yet. Retry this handoff; do not upload again.');
        acceptedRef.current = { reportId };
        if (epoch === epochRef.current) setAccepted(acceptedRef.current);
      }
      if (epoch !== epochRef.current) return;
      const next = await auctioneerService.continueWorkItem(current.workItemId, reportId);
      if (epoch !== epochRef.current) return;
      if (next.workItemId !== current.workItemId && next.reportType === current.reportType &&
          next.contract.id === current.contract.id && next.contract.contractNo === current.contract.contractNo &&
          (next.reportId || ['report_created', 'sent', 'abandoned'].includes(next.status || ''))) {
        setUsedSuccessor(next);
        setError(next.reportId ? `The next work item already has report ${next.reportId}. Close this view and reopen Incoming or Reports to review it. Your accepted report has not been uploaded again.` : 'The next work item is no longer available. Close this view and reopen Incoming to review its status. Your accepted report is safe.');
        return;
      }
      validateAuctioneerSuccessor(current, next);
      if (epoch !== epochRef.current) return;
      if (acceptedDraftRef.current) {
        await autoSaveService.removeDraftRecordOnly(acceptedDraftRef.current).catch(() => undefined);
      }
      if (epoch !== epochRef.current) return;
      acceptedRef.current = null;
      setAccepted(null);
      setRestoreDraft(false);
      setResolved({ inputKey, setup: next });
      props.onSetupChange?.(next);
    } catch (reason) {
      if (epoch === epochRef.current) setError(reason instanceof Error ? reason.message : 'Could not start the next lot. The accepted report is safe.');
    } finally {
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  if (!visible) return null;
  const showForm = !loading && !unavailable;
  const showGate = loading || Boolean(unavailable) || Boolean(accepted);
  const resumeOriginalDraft = Boolean(unavailable && current?.canResumeUpload === true);
  const buttonStyle = [styles.button, { borderColor: colors.borderStrong, backgroundColor: colors.surface }];
  return <>
    {showForm ? <React.Fragment key={current?.workItemId || 'ordinary'}>{props.children(current ? {
      setup: current, accepted: Boolean(accepted), restoreDraft, acceptAndContinue: continueAccepted,
    } : undefined)}</React.Fragment> : null}
    {showGate ? <Modal visible onRequestClose={() => { if (!busy) onClose(); }}>
      <SafeAreaView style={[styles.page, { backgroundColor: colors.background }]}>
        <ScrollView testID="auctioneer-handoff-scroll" contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={[styles.title, { color: colors.text }]}>{usedSuccessor ? 'Next work item already used' : resumeOriginalDraft ? 'Resume the original draft' : accepted ? 'Report accepted' : current?.reportId ? 'Report already created' : 'Auctioneer contract'}</Text>
            <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.textSecondary }]}>{error || (resumeOriginalDraft ? 'This upload has not been accepted yet. Close this view and reopen its original saved draft to resume the same photos and submission. A blank form cannot replace it.' : accepted ? 'Starting a fresh lot for the same contract. Your report continues processing.' : unavailable ? 'This work item is no longer an editable claim. Reopen Incoming to review its report or assignment.' : 'Validating the current claim and saved draft…')}</Text>
            {busy || (loading && !error) ? <ActivityIndicator color={colors.accent} accessibilityLabel="Checking Auctioneer work item" /> : null}
            {error && loading ? <TouchableOpacity accessibilityRole="button" onPress={() => setReload((value) => value + 1)} style={buttonStyle}><Text style={{ color: colors.text }}>Retry validation</Text></TouchableOpacity> : null}
            {accepted && !busy && !usedSuccessor ? <TouchableOpacity accessibilityRole="button" onPress={() => void continueAccepted()} style={buttonStyle}><Text style={{ color: colors.text }}>Retry new lot</Text></TouchableOpacity> : null}
            {!accepted && !resumeOriginalDraft && current?.reportId && current.status !== 'abandoned' ? <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => void continueAccepted()} style={buttonStyle}><Text style={{ color: colors.text }}>Continue with new lot</Text></TouchableOpacity> : null}
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onClose} style={buttonStyle}><Text style={{ color: colors.text }}>Close</Text></TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 24 },
  button: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
