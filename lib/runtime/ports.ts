import { createServer } from "node:net";

/** Reserve an ephemeral TCP port on the loopback interface. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
