import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { playlistCommandSchema } from '@hirmos/contracts';
import { PlaylistError, PlaylistRepository } from '../playlists/playlist-repository.js';
import type { Database } from '../db/database.js';
import { requireAuthentication } from './auth-routes.js';

export async function registerPlaylistRoutes(app:FastifyInstance, database?:Database):Promise<void> {
  const repository=database ? new PlaylistRepository(database) : undefined;
  await app.register(async routes=>{
    routes.addHook('preHandler',async(request,reply)=>{
      const denied=requireAuthentication(request,reply); if (denied) return denied;
      reply.header('cache-control','private, no-store');
      if (!repository) return reply.code(503).send({code:'NOT_CONFIGURED',message:'Las playlists no están disponibles.'});
    });
    routes.setErrorHandler((error,request,reply)=>{
      if (error instanceof PlaylistError) return reply.code(error.status).send({code:error.code,message:error.message,requestId:request.id});
      request.log.error({err:error},'Playlist operation failed');
      return reply.code(500).send({code:'PLAYLIST_ERROR',message:'No pudimos completar la operación.',requestId:request.id});
    });
    routes.get('/api/playlists',async request=>({playlists:await repository!.list(request.authSession!.response.user.id)}));
    routes.get('/api/playlists/:id',async(request,reply)=>{
      const params=z.object({id:z.uuid()}).safeParse(request.params);
      const query=z.object({offset:z.coerce.number().int().min(0).max(5000).default(0),revision:z.coerce.number().int().nonnegative().optional(),q:z.string().max(200).default('')}).safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({code:'INVALID_REQUEST',message:'La página solicitada no es válida.'});
      return repository!.page(request.authSession!.response.user.id,params.data.id,query.data.offset,query.data.revision,query.data.q);
    });
    routes.post('/api/playlists/commands',async(request,reply)=>{
      const parsed=playlistCommandSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({code:'INVALID_REQUEST',message:'Revisa el nombre (1–120 caracteres), descripción y selección.'});
      return repository!.command(request.authSession!.response.user.id,parsed.data);
    });
  });
}
