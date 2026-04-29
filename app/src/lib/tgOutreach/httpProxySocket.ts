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

    if (this.proxy) {
      this.client = await this._httpConnect(this.proxy, ip, port);
    } else {
      this.client = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        this.client!.connect(port, ip, () => resolve());
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

    this.client.on('error', () => { /* handled by close */ });
    this.client.on('close', () => {
      if (this.client?.destroyed) {
        this.resolveRead?.(false);
        this.closed = true;
      }
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
        socket.write(connectReq);
      });

      let responseBuffer = '';
      const onData = (chunk: Buffer) => {
        responseBuffer += chunk.toString();
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        socket.removeListener('data', onData);

        const statusLine = responseBuffer.split('\r\n')[0];
        const statusCode = parseInt(statusLine.split(' ')[1], 10);

        if (statusCode === 200) {
          const remaining = Buffer.from(responseBuffer.slice(headerEnd + 4));
          if (remaining.length > 0) {
            socket.unshift(remaining);
          }
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`HTTP CONNECT failed: ${statusLine}`));
        }
      };

      socket.on('data', onData);
      socket.on('error', (err) => reject(err));
      socket.setTimeout(15000, () => {
        socket.destroy();
        reject(new Error('HTTP CONNECT timeout'));
      });
    });
  }
}
