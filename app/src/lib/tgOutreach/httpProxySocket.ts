/**
 * Drop-in replacement for gramJS PromisedNetSockets that tunnels
 * through an HTTP CONNECT proxy instead of SOCKS.
 *
 * gramJS Connection calls: new Socket(proxy) → socket.connect(port, ip) → socket.write/read/close.
 * We implement the same interface but establish TCP via HTTP CONNECT tunnel.
 */
import * as net from 'net';
import { Mutex } from 'async-mutex';

const mutex = new Mutex();
const closeError = new Error('NetSocket was closed');

/**
 * Таймаут установки CONNECT-туннеля. 15с было мало для мобильных прокси
 * (Infatica и пр.): когда модем занят, рукопожатие легко занимает 20-30с,
 * и легитимные подключения резались. 40с — с запасом.
 */
const CONNECT_TIMEOUT_MS = Number(process.env.TG_PROXY_CONNECT_TIMEOUT_MS ?? '40000');

function proxyLog(msg: string) {
  console.log(`[HttpConnectSocket] ${msg}`);
}

interface HttpProxy {
  ip: string;
  port: number;
  username?: string;
  password?: string;
}

export class HttpConnectSocket {
  private client: net.Socket | undefined;
  private closed = true;
  private stream = Buffer.alloc(0);
  private canRead!: Promise<boolean | void>;
  private resolveRead?: (value: boolean | void) => void;
  private proxy: HttpProxy | undefined;

  constructor(proxy?: HttpProxy & Record<string, unknown>) {
    if (proxy?.ip && proxy?.port) {
      this.proxy = { ip: proxy.ip, port: proxy.port, username: proxy.username, password: proxy.password };
    }
  }

  async readExactly(number: number): Promise<Buffer> {
    let readData = Buffer.alloc(0);
    while (number > 0) {
      const thisTime = await this.read(number);
      readData = Buffer.concat([readData, thisTime]);
      number -= thisTime.length;
    }
    return readData;
  }

  async read(number: number): Promise<Buffer> {
    if (this.closed) throw closeError;
    await this.canRead;
    if (this.closed) throw closeError;
    const toReturn = this.stream.subarray(0, number);
    this.stream = this.stream.subarray(number);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => { this.resolveRead = resolve; });
    }
    return toReturn;
  }

  async readAll(): Promise<Buffer> {
    if (this.closed || !(await this.canRead)) throw closeError;
    const toReturn = this.stream;
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => { this.resolveRead = resolve; });
    return toReturn;
  }

  async connect(port: number, ip: string): Promise<this> {
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => { this.resolveRead = resolve; });
    this.closed = false;

    // gramJS hardcodes port 80 for non-WSS (and useWSS isn't allowed with proxies).
    // Residential proxies (Infatica etc.) DPI-classify raw MTProto on :80 as
    // err_protocol abuse and ban the source IP. Telegram MTProto-Obfuscated2
    // accepts traffic on any port, so we redirect the CONNECT to :443 — looks
    // like normal TLS to the proxy, behaves identically to Telegram.
    const targetPort = port === 80 ? 443 : port;

    if (this.proxy) {
      proxyLog(`connecting via CONNECT to ${ip}:${targetPort} (gramJS asked :${port}) through ${this.proxy.ip}:${this.proxy.port}`);
      this.client = await this._httpConnect(this.proxy, ip, targetPort);
      proxyLog(`CONNECT tunnel established to ${ip}:${targetPort}`);
    } else {
      this.client = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        this.client!.connect(targetPort, ip, () => resolve());
        this.client!.on('error', reject);
      });
    }

    this.client.on('data', async (message: Buffer) => {
      const release = await mutex.acquire();
      try {
        this.stream = Buffer.concat([this.stream, message]);
        this.resolveRead?.(true);
      } finally {
        release();
      }
    });

    this.client.on('error', (err) => {
      proxyLog(`socket error: ${err.message}`);
    });
    this.client.on('close', (hadError) => {
      proxyLog(`socket closed (hadError=${hadError}, destroyed=${this.client?.destroyed})`);
      if (this.client?.destroyed) {
        this.resolveRead?.(false);
        this.closed = true;
      }
    });
    this.client.on('end', () => {
      proxyLog('socket end (remote closed connection)');
    });

    return this;
  }

  write(data: Buffer): void {
    if (this.closed) throw closeError;
    this.client?.write(data);
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client.unref();
    }
    this.closed = true;
  }

  toString(): string {
    return 'HttpConnectSocket';
  }

  private _httpConnect(proxy: HttpProxy, destIp: string, destPort: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(proxy.port, proxy.ip, () => {
        let connectReq = `CONNECT ${destIp}:${destPort} HTTP/1.1\r\nHost: ${destIp}:${destPort}\r\n`;
        if (proxy.username) {
          const creds = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64');
          connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
        }
        connectReq += '\r\n';
        proxyLog(`sending CONNECT ${destIp}:${destPort} to ${proxy.ip}:${proxy.port}`);
        socket.write(connectReq);
      });

      let responseBuffer = '';
      const onData = (chunk: Buffer) => {
        responseBuffer += chunk.toString();
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        socket.removeListener('data', onData);

        const statusLine = responseBuffer.split('\r\n')[0];
        const allHeaders = responseBuffer.slice(0, headerEnd);
        const statusCode = parseInt(statusLine.split(' ')[1], 10);

        proxyLog(`CONNECT response: ${statusCode} | headers: ${allHeaders.replace(/\r\n/g, ' | ')}`);

        if (statusCode === 200) {
          // Снимаем idle-таймаут: он должен покрывать ТОЛЬКО фазу установки
          // туннеля. Дальше сокет уходит в gramJS под долгоживущее
          // MTProto-соединение, где паузы без трафика 15-60с (между пингами
          // и апдейтами) — норма. Если таймаут оставить, он убивал бы живое
          // соединение каждые N секунд → постоянные реконнекты в логах.
          socket.setTimeout(0);
          const remaining = Buffer.from(responseBuffer.slice(headerEnd + 4));
          if (remaining.length > 0) {
            proxyLog(`CONNECT had ${remaining.length} trailing bytes`);
            socket.unshift(remaining);
          }
          resolve(socket);
        } else {
          proxyLog(`CONNECT FAILED: ${allHeaders}`);
          socket.destroy();
          reject(new Error(`HTTP CONNECT failed: ${statusLine}`));
        }
      };

      socket.on('data', onData);
      socket.on('error', (err) => {
        proxyLog(`CONNECT socket error: ${err.message}`);
        reject(err);
      });
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        proxyLog(`CONNECT timeout after ${CONNECT_TIMEOUT_MS}ms to ${destIp}:${destPort}`);
        socket.destroy();
        reject(new Error('HTTP CONNECT timeout'));
      });
    });
  }
}
