// The Worker behind api.ravemonitor.com: the contact form (/contact, handler.js) and accounts
// (/v1/..., accounts.js). Both load in the tests without the Workers runtime; Email Routing's
// EmailMessage class only exists here.
import { EmailMessage } from 'cloudflare:email';
import { handle } from './handler.js';
import { handleAccounts } from './accounts.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1' || pathname.startsWith('/v1/')) return handleAccounts(request, env);
    return handle(request, env, { EmailMessage });
  }
};
