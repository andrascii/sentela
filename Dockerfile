# InfraPulse — single image used by both the web app and the background worker.
FROM node:20-alpine

# libc compat for some native deps
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the source and build the Next.js app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production
# 3000 = Next.js app; 3001 = realtime WebSocket service (same image, different command).
EXPOSE 3000
EXPOSE 3001

# Default command runs the web app. The worker service overrides this
# with `npm run worker` in docker-compose.yml.
CMD ["npm", "run", "start"]
