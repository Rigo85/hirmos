import sharp from 'sharp';

export class InvalidCachedImageError extends Error {
  public constructor(message = 'Image bytes could not be fully decoded') {
    super(message);
    this.name = 'InvalidCachedImageError';
  }
}

// Decode the complete first frame, not just its header. Keep the original bytes.
// Limit both decoded memory (at most 64 MiB RGBA) and CPU time per candidate.
export async function validateImage(bytes: Uint8Array): Promise<string> {
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 16_000_000, pages: 1 });
    const metadata = await image.metadata();
    const types: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png',
      webp: 'image/webp', gif: 'image/gif', heif: 'image/avif' };
    const contentType = types[metadata.format ?? ''];
    if (!contentType || (metadata.format === 'heif' && metadata.compression !== 'av1')) {
      throw new InvalidCachedImageError('Unsupported cached image format');
    }
    await image.timeout({ seconds: 5 }).raw().toBuffer();
    return contentType;
  } catch (error) {
    if (error instanceof InvalidCachedImageError) throw error;
    throw new InvalidCachedImageError();
  }
}
