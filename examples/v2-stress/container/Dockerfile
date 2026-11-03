# Built by `bun run build` from examples/v2-stress.
FROM oven/bun:1.4-alpine

WORKDIR /app
COPY dist/server.js ./server.js

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# The image is read-only at runtime; /data is the only writable mount.
USER bun
CMD ["bun", "server.js"]
