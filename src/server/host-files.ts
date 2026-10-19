import type { FastifyInstance } from "fastify";

/** Existing /@fs transport, with one decode so reserved filename characters survive. */
export function registerHostFileRoutes(app: FastifyInstance): void {
  app.get("/@fs/*", async (request, reply) => {
    try {
      const pathname = request.url.split("?", 1)[0]!;
      const filePath = decodeURIComponent(pathname.slice("/@fs".length));
      if (!filePath.startsWith("/") || filePath.includes("\0")) {
        return reply.code(400).send({ error: "Invalid file path" });
      }
      // Use the existing static plugin for MIME types, streaming and Range requests.
      return reply.sendFile(filePath, "/");
    } catch (error) {
      return reply
        .code(400)
        .send({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
}
