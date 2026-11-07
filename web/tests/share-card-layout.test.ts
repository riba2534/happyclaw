import { describe, expect, it } from 'vitest';
import {
  canvasLimits,
  exportPixelRatio,
  planShareCardExport,
} from '../src/components/chat/share-card-layout';

const ios = canvasLimits(true);
const android = canvasLimits(false);
const card = (width: number, height: number, clipped = false) => ({
  width,
  height,
  clipped,
});

describe('exportPixelRatio', () => {
  it('keeps the preferred ratio while the canvas fits', () => {
    expect(exportPixelRatio(720, 3000, 2, android)).toBe(2);
    expect(exportPixelRatio(390, 2000, 3, ios)).toBe(3);
  });

  it('stays within the long side html-to-image would scale down to', () => {
    expect(exportPixelRatio(720, 12_000, 2, android)).toBeCloseTo(
      16_384 / 12_000,
    );
  });

  it('stays within iOS Safari’s canvas area and long side', () => {
    expect(exportPixelRatio(390, 5184, 3, ios)).toBeCloseTo(
      Math.sqrt(14_000_000 / (390 * 5184)),
    );
    expect(exportPixelRatio(390, 11_975, 3, ios)).toBeCloseTo(14_000 / 11_975);
  });
});

describe('planShareCardExport', () => {
  it('exports a desktop card at 2x', () => {
    expect(planShareCardExport(card(720, 3000), false, android)).toEqual({
      pixelRatio: 2,
    });
  });

  it('keeps a short reply’s phone card at 3x', () => {
    expect(planShareCardExport(card(390, 3000), true, android)).toEqual({
      pixelRatio: 3,
    });
    expect(planShareCardExport(card(390, 3000), true, ios)).toEqual({
      pixelRatio: 3,
    });
  });

  it('keeps the phone card while iOS still allows at least 2x', () => {
    const plan = planShareCardExport(card(390, 5184), true, ios);
    expect(plan.relayoutWidth).toBeUndefined();
    expect(plan.pixelRatio).toBeGreaterThan(2);
    expect(plan.pixelRatio).toBeLessThan(3);
  });

  it('lays a phone card that cuts the reply out at 720', () => {
    expect(
      planShareCardExport(card(390, 20_108, true), true, android),
    ).toMatchObject({ relayoutWidth: 720 });
  });

  it('lays a phone card out at 720 once its long side drops it below 2x', () => {
    // iOS: 14000 / 11975 ≈ 1.17x; Android: 16384 / 9000 ≈ 1.82x.
    expect(planShareCardExport(card(390, 11_975), true, ios)).toMatchObject({
      relayoutWidth: 720,
    });
    expect(planShareCardExport(card(390, 9000), true, android)).toMatchObject({
      relayoutWidth: 720,
    });
  });

  it('exports the 720 fallback like the desktop card, cut or not', () => {
    expect(planShareCardExport(card(720, 6000), true, android)).toEqual({
      pixelRatio: 2,
    });
    expect(planShareCardExport(card(720, 20_100, true), true, ios)).toEqual({
      pixelRatio: exportPixelRatio(720, 20_100, 2, ios),
    });
  });

  it('treats a phone card a table widened to 720 or more as the default card', () => {
    expect(planShareCardExport(card(900, 3000), true, android)).toEqual({
      pixelRatio: 2,
    });
  });
});
