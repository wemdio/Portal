import fs from 'node:fs';
import { createBroker } from '@/lib/enrich/engBrowser/broker';

const token = process.env.ENG_BROWSER_TOKEN;
const socket = process.env.ENG_BROWSER_BROKER_SOCKET ?? '/sockets/broker.sock';
const runnerSocket = process.env.ENG_BROWSER_RUNNER_SOCKET ?? '/sockets/runner.sock';
if (!token || Buffer.byteLength(token) < 32) throw new Error('ENG_BROWSER_TOKEN must contain at least 32 bytes');
try { fs.unlinkSync(socket); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const broker = createBroker({ token, runnerSocket });
broker.internal.listen(socket, () => fs.chmodSync(socket, 0o600));
broker.render.listen(Number(process.env.ENG_BROWSER_PORT ?? 4100), '0.0.0.0');
