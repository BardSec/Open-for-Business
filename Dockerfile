FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Run as a non-root user so a container escape or RCE doesn't give root.
# Create the state directory first so the volume inherits app ownership on first run.
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/state \
    && chown -R app:app /app
USER app

EXPOSE 3000

CMD ["node", "server.js"]
