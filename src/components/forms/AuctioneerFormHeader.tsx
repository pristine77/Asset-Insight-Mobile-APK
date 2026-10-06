import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';

export default function AuctioneerFormHeader({ setup, disabled, onPress }: {
  setup: AuctioneerWorkItemSetup;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  return <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.text }]}>Contract {setup.contract.contractNo}{setup.kind === 'scheduleA' ? ' · Schedule A lots are locked' : ''}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Generate files & new lot"
      accessibilityState={{ disabled }} style={[styles.button, { backgroundColor: colors.accent, opacity: disabled ? 0.5 : 1 }]}
      disabled={disabled} onPress={onPress}>
      <Text style={[styles.buttonText, { color: colors.accentText }]}>Generate files &amp; new lot</Text>
    </TouchableOpacity>
    <Text style={[styles.hint, { color: colors.textSecondary }]}>Drafts save on this device. The report continues processing; the next lot starts with empty media.</Text>
  </View>;
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6, borderBottomWidth: 1 },
  title: { fontSize: 14, fontWeight: '600' },
  button: { minHeight: 48, padding: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  hint: { fontSize: 12, lineHeight: 17 },
});
