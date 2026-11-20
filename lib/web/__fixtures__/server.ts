import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface TestServer {
  origin: string;
  close(): Promise<void>;
}

/** Start a throwaway HTTP server on a loopback port. */
export async function startServer(handler: RequestHandler): Promise<TestServer> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Clients such as a headless browser keep sockets alive, so close
        // them explicitly or `close()` never settles.
        server.closeAllConnections();
      }),
  };
}

/** Read a request body as UTF-8. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
