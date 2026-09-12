import { cacheRequest } from './handlers/request-handler';
import { fetchAccessToken } from './services/fetchUtils';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      // awaited so async rejections are also caught here
      return await cacheRequest(request, env, ctx);
    } catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      return Response.json({ error: e?.message ?? 'Internal Server Error' }, { status });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(fetchAccessToken(env.OAUTH, env.SB_CACHE));
  },
};
