import type { SessionResponse } from '@hirmos/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    authSession: {
      id: string;
      response: SessionResponse;
    } | null;
  }
}

export {};
