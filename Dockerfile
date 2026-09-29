FROM node:24-bookworm-slim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node server.js package.json LICENSE README.md ./
COPY --chown=node:node scripts/container.js scripts/storage.js scripts/restore.js scripts/upgrade.js scripts/folderbackup.js scripts/fetch-5etools.js ./scripts/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node sample/ ./sample/
USER node
ENV NODE_ENV=production MUNDUSMAKER_DATA=/data MUNDUSMAKER_PASSWORD_FILE=/run/secrets/mundusmaker_password
VOLUME ["/data"]
EXPOSE 4870
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/container.js", "--healthcheck"]
CMD ["node", "scripts/container.js"]
