# AlumNet server (Node and Express) for a Hugging Face Docker Space.
# The deploy workflow copies this file, backend/ and database/ into the Space.
# The pages themselves are served by Cloudflare Pages, not from here.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=7860 \
    MEDIA_DRIVER=db
WORKDIR /home/node/app
# Spaces run containers as user 1000, which is "node" in this image
RUN chown node:node /home/node/app
USER node

COPY --chown=node backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev

COPY --chown=node backend backend
COPY --chown=node database database

EXPOSE 7860
# Applies any new database migrations, then starts the server
CMD ["sh", "-c", "cd backend && node scripts/migrate.js && node src/server.js"]
