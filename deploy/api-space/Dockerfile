# AlumNet server (Node and Express). The deploy workflow builds it from this
# file, backend/ and database/, and Azure Container Apps runs it.
# The pages themselves are served by Cloudflare Pages, not from here.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=7860 \
    MEDIA_DRIVER=db
WORKDIR /home/node/app
# Run as the image's ordinary "node" user, never as root
RUN chown node:node /home/node/app
USER node

COPY --chown=node backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev

COPY --chown=node backend backend
COPY --chown=node database database

EXPOSE 7860
# Waits for the database if it is not reachable yet, applies any new
# migrations, then starts the server (backend/scripts/start.js)
WORKDIR /home/node/app/backend
CMD ["node", "scripts/start.js"]
