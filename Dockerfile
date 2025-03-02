# Use an official Node.js image as the base
FROM node:18

# Update package lists and install Python3, pip, and ffmpeg
RUN apt-get update && apt-get install -y python3-pip ffmpeg

# Install yt-dlp using pip3 with system override flag (if needed elsewhere)
RUN pip3 install --break-system-packages yt-dlp

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
