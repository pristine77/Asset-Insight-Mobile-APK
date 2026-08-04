import React, { useMemo } from 'react';
import {
  Image,
  ImageBackground,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';

const BrandIcon = require('../../assets/icon.png');
const EquipmentArtwork = require('../../assets/auth-equipment-yard.png');

interface CrmEntryScreenProps {
  onSelectListings: () => void;
  onSelectCrm: () => void;
}

const CrmEntryScreen = ({ onSelectListings, onSelectCrm }: CrmEntryScreenProps) => {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= 700;
  const compactHeight = height < 720;
  const { isDark, colors, toggleTheme } = useAppTheme();
  const styles = useMemo(
    () => createStyles(colors, isTablet, compactHeight),
    [colors, compactHeight, isTablet]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}>
        <ImageBackground source={EquipmentArtwork} style={styles.hero} imageStyle={styles.heroImage}>
          <View style={styles.heroTopRow}>
            <View style={styles.logoPlate}>
              <Image source={BrandIcon} style={styles.logo} resizeMode="contain" />
            </View>
            <TouchableOpacity onPress={toggleTheme} style={styles.themeButton} activeOpacity={0.75}>
              <Feather name={isDark ? 'sun' : 'moon'} size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>Choose your workspace</Text>
            <Text style={styles.heroSubtitle}>Continue to appraisals or manage customer follow-up.</Text>
          </View>
        </ImageBackground>

        <View style={styles.workspaceSection}>
          <Text style={styles.sectionTitle}>Where are you working?</Text>
          <Text style={styles.sectionSubtitle}>Your selection can be changed later from the side menu.</Text>

          <View style={styles.workspaceGrid}>
            <TouchableOpacity style={styles.workspaceCard} onPress={onSelectListings} activeOpacity={0.76}>
              <View style={[styles.workspaceIcon, { backgroundColor: colors.accentSoft }]}>
                <Feather name="briefcase" size={24} color={colors.accent} />
              </View>
              <View style={styles.workspaceCopy}>
                <Text style={styles.workspaceTitle}>Listings</Text>
                <Text style={styles.workspaceDescription}>
                  Create Asset, Lot Listing, Real Estate, and Salvage reports.
                </Text>
                <View style={styles.featureRow}>
                  <Feather name="check" size={13} color={colors.success} />
                  <Text style={styles.featureText}>Reports, previews, files</Text>
                </View>
              </View>
              <View style={[styles.workspaceArrow, { backgroundColor: colors.accent }]}>
                <Feather name="arrow-right" size={17} color="#FFFFFF" />
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.workspaceCard} onPress={onSelectCrm} activeOpacity={0.76}>
              <View style={[styles.workspaceIcon, { backgroundColor: colors.infoSoft }]}>
                <Feather name="headphones" size={24} color={colors.info} />
              </View>
              <View style={styles.workspaceCopy}>
                <Text style={styles.workspaceTitle}>CRM</Text>
                <Text style={styles.workspaceDescription}>
                  Manage leads, tasks, calls, and scheduled customer follow-up.
                </Text>
                <View style={styles.featureRow}>
                  <Feather name="check" size={13} color={colors.success} />
                  <Text style={styles.featureText}>Leads, calendar, activity</Text>
                </View>
              </View>
              <View style={[styles.workspaceArrow, { backgroundColor: colors.info }]}>
                <Feather name="arrow-right" size={17} color="#FFFFFF" />
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors, isTablet: boolean, compactHeight: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: { flexGrow: 1, maxWidth: 920, width: '100%', alignSelf: 'center' },
    hero: {
      minHeight: compactHeight ? 260 : isTablet ? 390 : 330,
      paddingHorizontal: isTablet ? 28 : 16,
      paddingVertical: 16,
      justifyContent: 'space-between',
      backgroundColor: colors.graphite,
    },
    heroImage: { resizeMode: 'cover' },
    heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    logoPlate: { width: 142, height: 50, borderRadius: 9, paddingHorizontal: 8, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },
    logo: { width: 124, height: 38 },
    themeButton: { width: 40, height: 40, borderRadius: 9, backgroundColor: 'rgba(9,12,18,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
    heroCopy: { maxWidth: 560, backgroundColor: 'rgba(9,12,18,0.82)', borderLeftWidth: 4, borderLeftColor: colors.accent, padding: 14, borderRadius: 8 },
    heroTitle: { color: '#FFFFFF', fontSize: isTablet ? 30 : 25, fontWeight: '900' },
    heroSubtitle: { color: '#D5DAE3', fontSize: 12.5, lineHeight: 18, marginTop: 5 },
    workspaceSection: { paddingHorizontal: isTablet ? 28 : 16, paddingVertical: compactHeight ? 18 : 24 },
    sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
    sectionSubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 16 },
    workspaceGrid: { flexDirection: isTablet ? 'row' : 'column', gap: 12 },
    workspaceCard: { flex: 1, minHeight: compactHeight ? 132 : 150, borderRadius: 11, borderWidth: 1, borderColor: colors.border, borderBottomWidth: 4, borderBottomColor: colors.borderStrong, backgroundColor: colors.surfaceRaised, padding: 14, flexDirection: 'row', alignItems: 'center', shadowColor: colors.shadow, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.12, shadowRadius: 11, elevation: 5 },
    workspaceIcon: { width: 50, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    workspaceCopy: { flex: 1, minWidth: 0 },
    workspaceTitle: { color: colors.text, fontSize: 17, fontWeight: '900' },
    workspaceDescription: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
    featureRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9 },
    featureText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700' },
    workspaceArrow: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  });

export default CrmEntryScreen;
