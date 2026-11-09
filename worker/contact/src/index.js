// The Worker's entry point. The form logic is in handler.js, which the tests load without the
// Workers runtime; Email Routing's EmailMessage class only exists here.
import { EmailMessage } from 'cloudflare:email';
import { handle } from './handler.js';

export default { fetch: (request, env) => handle(request, env, { EmailMessage }) };
