import fs from 'node:fs';
import path from 'node:path';

// October 6: restore September controls without shrinking labels.
// Short screens use a visible scroll affordance; emulator tests verify Done is reachable.
const layout = fs.readFileSync(path.resolve(__dirname,
  '../../modules/auction-camera/android/src/main/res/layout-land/activity_camera_view.xml'), 'utf8');
function element(id: string): string {
  const at = layout.indexOf(`android:id="@+id/${id}"`);
  expect(at).toBeGreaterThan(0);
  return layout.slice(layout.lastIndexOf('<', at), layout.indexOf('>', at) + 1);
}
describe('September landscape camera controls', () => {
  it('makes scrolling discoverable on short and large-font screens', () => {
    const scroll = element('rightPanelScroll');
    expect(scroll).toContain('<ScrollView');
    expect(scroll).toContain('android:scrollbars="vertical"');
    expect(scroll).toContain('android:fadeScrollbars="false"');
    expect(scroll).toContain('app:layout_constraintBottom_toBottomOf="parent"');
  });
  it('keeps the controls in a vertically scrollable, unconstrained-height panel', () => {
    expect(element('rightPanel')).toContain('android:layout_height="wrap_content"');
    expect(element('rightPanel')).toContain('android:orientation="vertical"');
    expect(layout.indexOf('android:id="@+id/textViewDone"')).toBeLessThan(layout.indexOf('</ScrollView>'));
  });
  it('retains the full-size capture group', () => {
    expect(element('bottomPanel')).toContain('android:layout_height="wrap_content"');
    expect(layout).not.toContain('rightPanelColumn');
  });
  it.each(['textViewBundle', 'textViewItem', 'textViewPhoto', 'textViewBundleExtra', 'imageLeftArrow', 'imageRightArrow', 'textViewDone'])(
    '%s keeps its September text size instead of shrinking', (id) => {
      expect(element(id)).toMatch(/android:textSize="1[234]sp"/);
      expect(element(id)).not.toContain('autoSizeMinTextSize');
    }
  );
});
