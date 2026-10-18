import type { SplitImageGrid } from '@lesebuehne/director';

/** Browser-only equivalent of the server cropper; each tile is cached separately. */
export const splitImageGrid: SplitImageGrid = async (bytes, mime) => {
  const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    if (image.width < 2 || image.height < 2) throw new Error('image is too small for a 2x2 grid');
    const w = Math.floor(image.width / 2), h = Math.floor(image.height / 2);
    const tiles = [];
    for (let i = 0; i < 4; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = i % 2 ? image.width - w : w;
      canvas.height = i > 1 ? image.height - h : h;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('image cropping is unavailable');
      context.drawImage(image, i % 2 ? w : 0, i > 1 ? h : 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('image cropping failed')), 'image/png'));
      tiles.push({ image: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' });
    }
    return tiles;
  } finally { image.close(); }
};
