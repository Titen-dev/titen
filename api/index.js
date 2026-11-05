// Vercel entry point: every request goes to the Titen web app (see vercel.json).
// Vercel's Node runtime calls this like a plain node:http request handler.
import { createApp } from '../web/server.js';

const app = createApp();
const handle = app.server.listeners('request')[0];

export default function handler(req, res) {
  return handle(req, res);
}
