# Use official Node.js LTS base image (Debian slim)
FROM node:18-slim AS build

# Set working directory
WORKDIR /app

# Install ffmpeg & chromium via apt
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
 && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose application port
EXPOSE 8080

# Start the server
CMD ["node", "server-segment-two.js"]
