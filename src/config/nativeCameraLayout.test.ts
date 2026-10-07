import fs from 'node:fs';
import path from 'node:path';

const main = path.resolve(__dirname, '../../modules/auction-camera/android/src/main');
const read = (file: string) => fs.readFileSync(path.join(main, file), 'utf8');

describe('September listing camera controls with current video support', () => {
  it('keeps readable landscape controls instead of the shrinking October column', () => {
    const xml = read('res/layout-land/activity_camera_view.xml');
    expect(xml).toContain('android:id="@+id/rightPanelScroll"');
    expect(xml).not.toContain('rightPanelColumn');
    expect(xml).not.toContain('autoSizeMinTextSize');
    expect(xml).toContain('android:scrollbars="vertical"');
    expect(xml).toContain('android:fadeScrollbars="false"');
    for (const label of ['Bundle', 'Item', 'Photo', '+ Extra', '✔ Done']) {
      expect(xml).toContain(`android:text="${label}"`);
    }
  });

  it.each(['layout', 'layout-land'])('retains recording and Done controls in %s', (layout) => {
    const xml = read(`res/${layout}/activity_camera_view.xml`);
    for (const id of ['imageViewRecordVideo', 'textViewDone', 'galleryVideoBadge']) {
      expect(xml).toContain(`android:id="@+id/${id}"`);
    }
  });

  it('keeps the strict 720p/30fps native recording profile', () => {
    const profile = read('java/expo/modules/auctioncamera/viewextensions/ListingVideoProfile.kt');
    expect(profile).toContain('const val FRAMES_PER_SECOND = 30');
    expect(profile).toContain('QualitySelector.from(Quality.HD)');
    expect(profile).toContain('.setTargetFrameRate(frameRate)');
    expect(profile).toContain('minOf(width, height) == 720 && maxOf(width, height) == 1280');
    const engine = read('java/expo/modules/auctioncamera/viewextensions/CameraViewEngine.kt');
    expect(engine).toContain('ListingVideoProfile.buildCapture(currentRotation)');
    expect(engine).toContain('ListingVideoProfile.requireBoundProfile(videoCapture)');
  });
});
