import { connect } from "node:net";

export type FileSafetyScanner = {
  scan(bytes: Uint8Array): Promise<"CLEAN" | "INFECTED">;
};

export function createClamAvFileSafetyScanner(host: string, port: number): FileSafetyScanner {
  return {
    async scan(bytes) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const chunks: Buffer[] = [];

        socket.setTimeout(30_000);
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          const byteLength = Buffer.alloc(4);
          byteLength.writeUInt32BE(bytes.byteLength);
          socket.write(byteLength);
          socket.write(bytes);
          socket.write(Buffer.alloc(4));
        });
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("timeout", () => socket.destroy(new Error("virus scan timed out")));
        socket.on("error", reject);
        socket.on("end", () => {
          const response = Buffer.concat(chunks).toString("utf8");
          if (response.includes("FOUND")) return resolve("INFECTED");
          if (response.includes("OK")) return resolve("CLEAN");
          return reject(new Error("virus scan failed"));
        });
      });
    },
  };
}
