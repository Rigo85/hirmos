import { z } from 'zod';

export const queuePlacementSchema = z.enum(['queue', 'next', 'end']);
export type QueuePlacement = z.infer<typeof queuePlacementSchema>;
export const queueOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), placement: queuePlacementSchema,
    trackRefs: z.array(z.string().min(1).max(2048)).min(1).max(5000) }),
  z.object({ action: z.literal('add-playlist'), placement: queuePlacementSchema,
    playlistId: z.uuid(), playlistRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal('move'), itemIds: z.array(z.uuid()).min(1).max(5000),
    beforeId: z.uuid().nullable(), priority: z.boolean() }),
  z.object({ action: z.literal('remove'), itemIds: z.array(z.uuid()).min(1).max(5000) }),
  z.object({ action: z.literal('clear-upcoming') }),
  z.object({ action: z.literal('select'), itemId: z.uuid() }),
  z.object({ action: z.literal('undo'), undoId: z.uuid() }),
]);
export type QueueOperation = z.infer<typeof queueOperationSchema>;
export const queueEditSchema = z.object({
  commandId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  expectedQueueRevision: z.number().int().nonnegative(),
  currentQueueItemId: z.uuid().nullable(), playbackInstanceId: z.uuid().nullable(),
  expectedStatus: z.enum(['playing', 'paused', 'stopped']), operation: queueOperationSchema,
});
export type QueueEditCommand = z.infer<typeof queueEditSchema>;
