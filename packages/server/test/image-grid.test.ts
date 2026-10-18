import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { MemoryCache, ProviderRegistry } from '@lesebuehne/core';
import { ImageDirector, type ImageOptions } from '@lesebuehne/director';
import { splitImageGrid } from '../src/image-grid.ts';
import { bundleOf } from '../../player/test/ui/support.ts';
import { scenePlan, imageScenes } from '../../player/src/ai/image-sequence.ts';
import { buildTimeline } from '@lesebuehne/core';

async function sheet() {
  const pixels = Buffer.alloc(7 * 5 * 3);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) pixels.set(colors[(y >= 2 ? 2 : 0) + (x >= 3 ? 1 : 0)]!, (y * 7 + x) * 3);
  return new Uint8Array(await sharp(pixels, { raw: { width: 7, height: 5, channels: 3 } }).png().toBuffer());
}

describe('2x2 image batches', () => {
  test('crops the actual dimensions into four distinct images in reading order', async () => {
    const tiles = await splitImageGrid(await sheet(), 'image/png');
    const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (const [i, tile] of tiles.entries()) {
      const { data, info } = await sharp(tile.image).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([i % 2 ? 4 : 3, i > 1 ? 3 : 2]);
      expect([...data.slice(0, 3)]).toEqual(expected[i]!);
      expect([...data.slice(-3)]).toEqual(expected[i]!);
    }
  });

  test('one provider request creates four cached crops and uses a single crop as the style reference', async () => {
    const bytes = await sheet();
    const requests: Array<{ prompt: string; styleRef?: Uint8Array }> = [];
    const registry = new ProviderRegistry().register({ kind: 'image', id: 'test', label: 'test', runsIn: ['server'], capabilities: {},
      isAvailable: async () => ({ ok: true }), generate: async req => { requests.push(req); return { image: bytes, mime: 'image/png' }; } });
    const files = new Map<string, Uint8Array>();
    const director = new ImageDirector({ registry, chain: ['test'], cache: new MemoryCache(),
      store: { get: async name => files.get(name), put: async (name, data) => { files.set(name, data); } },
      splitGrid: splitImageGrid, styleReference: true, styleBible: async () => undefined });
    const book = bundleOf('grid.txt', new TextEncoder().encode('Ein Boot schwimmt. Ein Baum wächst.')).book;
    const plan = scenePlan(imageScenes(buildTimeline(book), { interval: 'sentence', seconds: 30, grid: true })[0]!);
    const options: ImageOptions = { panels: ['A boat', 'A tree', 'A bridge', 'A cloud'] };
    const result = await director.generate(book, 'group', plan, options, new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('TOP RIGHT: A tree');
    expect(result.tiles).toHaveLength(4);
    expect(files.size).toBe(5);
    expect(new Set(result.tiles!.map(t => t.file)).size).toBe(4);
    const cached = await director.generate(book, 'group', plan, options, new AbortController().signal);
    expect(cached.cached).toBe(true);
    expect(cached.tiles).toEqual(result.tiles);
    expect(requests).toHaveLength(1);
    await director.generate(book, 'group', plan, { ...options, regenerate: true }, new AbortController().signal);
    expect(requests).toHaveLength(2);
    const reference = await sharp(requests[1]!.styleRef!).metadata();
    expect([reference.width, reference.height]).toEqual([3, 2]);
  });
});
