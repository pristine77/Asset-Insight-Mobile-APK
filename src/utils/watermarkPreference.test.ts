import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IMAGE_WATERMARK, restoreImageWatermarkPreference } from './watermarkPreference';

// Owner request 2026-10-03: add the logo wherever it is missing. The server
// leaves photos that already show it alone, so the rule is on by default.
describe('native image watermark preference', () => {
  it('starts new reports and resets with the logo rule on', () => {
    expect(DEFAULT_IMAGE_WATERMARK).toBe(true);
  });

  it.each([undefined, null, '', 'true', 'false', 0, 1])('gives absent or unreadable stored value %p the default (on)', (stored) => {
    expect(restoreImageWatermarkPreference(stored)).toBe(true);
  });

  it('preserves explicit saved opt-in and opt-out', () => {
    expect(restoreImageWatermarkPreference(true)).toBe(true);
    expect(restoreImageWatermarkPreference(false)).toBe(false);
  });

  it.each([
    ['AssetFormSheet.tsx', 1, 3],
    // Close now uses the same resetForm path instead of duplicating every setter.
    ['LotListingFormSheet.tsx', 2, 2],
  ] as const)('wires %s fresh/reset/restore paths through the default-on policy', (file, resetCount, restoreCount) => {
    const source = fs.readFileSync(path.join(__dirname, '../components/forms', file), 'utf8');
    expect(source).toContain('const [watermarkImages, setWatermarkImages] = useState(DEFAULT_IMAGE_WATERMARK)');
    expect(source.match(/setWatermarkImages\(DEFAULT_IMAGE_WATERMARK\)/g)).toHaveLength(resetCount);
    expect(source.match(/setWatermarkImages\(restoreImageWatermarkPreference\(/g)).toHaveLength(restoreCount);
    expect(source).not.toContain('setWatermarkImages(true)');
    expect(source).not.toContain('watermarkImages !== false');
    expect(source).toContain('watermark_images: watermarkImages');
    expect(source).toContain('Add logo where missing');
    expect(source).toContain('so no photo gets two. On by default.');
    expect(source).not.toContain('Apply watermark');
  });
});
