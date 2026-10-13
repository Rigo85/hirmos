import {z} from 'zod';

/** Immutable pieces of heard audio, not playback commands or scrobbles. */
export const offlineListenSchema=z.object({
  id:z.uuid(),executionId:z.uuid(),reference:z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/),
  startedAt:z.iso.datetime(),at:z.iso.datetime(),heardMs:z.number().int().min(1).max(60_000),
}).strict().refine(v=>Date.parse(v.at)>=Date.parse(v.startedAt)
  && v.heardMs<=Date.parse(v.at)-Date.parse(v.startedAt)+1_000);
export const offlineListenBatchSchema=z.object({reports:z.array(offlineListenSchema).min(1).max(50)}).strict();
export type OfflineListen=z.infer<typeof offlineListenSchema>;
export const offlineListenAckSchema=z.object({accepted:z.array(z.uuid()).max(50),
  rejected:z.array(z.object({id:z.uuid(),code:z.enum(['INVALID_REFERENCE','UNKNOWN_TRACK','INVALID_TIME','ID_CONFLICT'])})).max(50)});
export type OfflineListenAck=z.infer<typeof offlineListenAckSchema>;
