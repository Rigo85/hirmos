export interface DecodedTrackReference {
  sourceId: string;
  remoteId: string;
}

export function encodeTrackReference(sourceId: string, remoteId: string): string {
  return Buffer.from(`${sourceId}\0${remoteId}`, 'utf8').toString('base64url');
}

export function decodeTrackReference(reference: string): DecodedTrackReference | null {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(reference)) return null;
  try {
    const decoded = Buffer.from(reference, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\0');
    if (separator < 1 || separator === decoded.length - 1) return null;
    return { sourceId: decoded.slice(0, separator), remoteId: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
