import { z } from 'zod';

// Explicit capacity, never a silent truncation. UI pages are independent.
export const PLAYLIST_CAPACITY = 5000;
const base = { commandId: z.uuid() };
const owned = { ...base, playlistId: z.uuid(), expectedRevision: z.number().int().nonnegative() };
const name = z.string().trim().min(1).max(120);
const ids = z.array(z.uuid()).min(1).max(PLAYLIST_CAPACITY);
export const playlistCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action:z.literal('from-queue'),name,description:z.string().max(2000).default(''),
    scope:z.enum(['all','remaining']),expectedQueueRevision:z.number().int().nonnegative(),currentQueueItemId:z.uuid().nullable() }),
  z.object({ ...base, action: z.literal('create'), name, description: z.string().max(2000).default('') }),
  z.object({ ...owned, action: z.literal('rename'), name, description: z.string().max(2000) }),
  z.object({ ...owned, action: z.literal('delete') }),
  z.object({ ...owned, action: z.literal('duplicate'), name }),
  z.object({ ...owned, action: z.literal('add'), trackRefs: z.array(z.string().min(1).max(2048)).min(1).max(PLAYLIST_CAPACITY), duplicates: z.literal('skip').default('skip') }),
  z.object({ ...owned, action: z.literal('remove'), itemIds: ids }),
  z.object({ ...owned, action: z.literal('move'), itemIds: ids, beforeId: z.uuid().nullable() }),
]);
export type PlaylistCommand = z.infer<typeof playlistCommandSchema>;
export interface PlaylistSummary {
  id: string; name: string; description: string; revision: number;
  count: number; durationMs: number; covers: string[];
}
export interface PlaylistCommandResult { playlistId: string; revision: number; added: number; skipped: number }
