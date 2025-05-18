# Use official Node.js LTS base image
FROM node:18-bullseye-slim

# Set working directory
WORKDIR /app

# Install ffmpeg runtime dependencies
RUN apk add --no-cache \
    ffmpeg \
    chromium

# Copy package manifests
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 8080

# Set default command
CMD ["node", "server-segment-two.js"]
