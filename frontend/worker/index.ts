import { adminEvent, adminRestore, adminSearch, json, publicContext } from './swell-server.ts';

const routes: Record<string, { method: string; handler: (request: Request) => Promise<Response> | Response }> = {
  '/app-api/context': { method: 'GET', handler: publicContext },
  '/app-api/admin/search': { method: 'POST', handler: adminSearch },
  '/app-api/admin/event': { method: 'GET', handler: adminEvent },
  '/app-api/admin/restore': { method: 'POST', handler: adminRestore },
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/app-api' || pathname.startsWith('/app-api/')) {
      const route = routes[pathname];
      if (!route) return json({ error: 'Not found' }, 404);
      return request.method === route.method ? route.handler(request) : json({ error: 'Method not allowed' }, 405);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
