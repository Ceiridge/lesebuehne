import sharp from 'sharp';
import type { SplitImageGrid } from '@lesebuehne/director';

/** Crop from the actual returned dimensions, including odd-sized provider output. */
export const splitImageGrid: SplitImageGrid = async (image) => {
  const source = sharp(image, { limitInputPixels: 64_000_000 });
  const { width, height } = await source.metadata();
  if (!width || !height || width < 2 || height < 2) throw new Error('image is too small for a 2x2 grid');
  const halfW = Math.floor(width / 2), halfH = Math.floor(height / 2);
  return Promise.all([0, 1, 2, 3].map(async i => {
    const left = i % 2 ? halfW : 0, top = i > 1 ? halfH : 0;
    const bytes = await source.clone().extract({ left, top, width: i % 2 ? width - halfW : halfW, height: i > 1 ? height - halfH : halfH }).png().toBuffer();
    return { image: new Uint8Array(bytes), mime: 'image/png' };
  }));
};
