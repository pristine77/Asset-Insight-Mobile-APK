import fs from 'node:fs';
import path from 'node:path';

/**
 * Landscape camera controls must fit the screen without scrolling (owner report
 * 2026-10-03: on a phone with large text, Done sat below the screen edge inside
 * a scroll view). These checks pin the layout rules that guarantee it.
 */
const layout = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../modules/auction-camera/android/src/main/res/layout-land/activity_camera_view.xml'
  ),
  'utf8'
);

/** The XML element that declares `id`, from its opening tag to the next element. */
function element(id: string): string {
  const at = layout.indexOf(`android:id="@+id/${id}"`);
  expect(at).toBeGreaterThan(0);
  const start = layout.lastIndexOf('<', at);
  const end = layout.indexOf('>', at);
  return layout.slice(start, end + 1);
}

describe('landscape camera controls fit the screen', () => {
  it('has no scroll view that could hide Done', () => {
    expect(layout).not.toMatch(/<ScrollView\b/);
    expect(layout).not.toContain('rightPanelScroll');
  });

  it('pins Prev / Next / Done to the bottom of the right-hand column', () => {
    const column = element('rightPanelColumn');
    expect(column).toContain('androidx.constraintlayout.widget.ConstraintLayout');
    expect(column).toContain('app:layout_constraintTop_toTopOf="parent"');
    expect(column).toContain('app:layout_constraintBottom_toBottomOf="parent"');
    expect(element('linearLayoutLotLeftRight')).toContain('app:layout_constraintBottom_toBottomOf="parent"');
    expect(layout.indexOf('android:id="@+id/textViewDone"')).toBeGreaterThan(
      layout.indexOf('android:id="@+id/linearLayoutLotLeftRight"')
    );
  });

  it('lets the capture buttons share the height in between, at most their usual size', () => {
    const buttons = element('captureButtons');
    expect(buttons).toContain('android:layout_height="0dp"');
    expect(buttons).toContain('app:layout_constraintTop_toBottomOf="@id/galleryRow"');
    expect(buttons).toContain('app:layout_constraintBottom_toTopOf="@id/linearLayoutLotLeftRight"');
    expect(buttons).toContain('app:layout_constraintHeight_max="210dp"');
  });

  it.each(['textViewBundle', 'textViewItem', 'textViewPhoto', 'textViewBundleExtra', 'imageLeftArrow', 'imageRightArrow', 'textViewDone'])(
    '%s shrinks its text instead of clipping it',
    (id) => {
      const button = element(id);
      expect(button).toContain('app:autoSizeTextType="uniform"');
      expect(button).toContain('android:maxLines="1"');
    }
  );
});
