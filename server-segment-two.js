const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

// Serve the 'videos' folder as static content.
app.use('/videos', express.static(path.join(__dirname, 'videos')));

const downloadsDir = path.join(__dirname, 'downloads');
const cookiesPath = path.join(__dirname, 'youtube-cookies.txt'); // Set your cookies file path

// Ensure the downloads and videos directories exist.
(async () => {
  try {
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.chmod(downloadsDir, '777');
    await fs.mkdir(path.join(__dirname, 'videos'), { recursive: true });
  } catch (err) {
    console.error('Error creating directories:', err);
  }
})();

app.get('/', (req, res) => {
  res.send('API for getting video URLs is running!');
});

/**
 * Endpoint: /get-video-urls
 * - Downloads two video segments:
 *    1. Main video segment (from startSeconds to endSeconds) with audio.
 *    2. Background segment (from 0 to (endSeconds - startSeconds)) as video only.
 * - Re-encodes both segments at a lower quality (using CRF 28).
 * - Saves the re-encoded files to a public folder (served as /videos).
 * - Returns a JSON object with:
 *      clip_url, gameplay_url (set to main video URL) and background_url.
 */
app.post('/get-video-urls', async (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  
  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({
      error: 'Invalid or missing fields: mainUrl, backgroundUrl, startSeconds, endSeconds.'
    });
  }
  
  const duration = end - start;
  const timestamp = Date.now();

  // Temporary download file paths
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `background-${timestamp}.mp4`);
  
  // Re-encoded output paths (will be copied to public folder)
  const reencodedMainPath = path.join(downloadsDir, `main-reencoded-${timestamp}.mp4`);
  const reencodedBackgroundPath = path.join(downloadsDir, `background-reencoded-${timestamp}.mp4`);
  
  // Public folder paths and URLs (adjust your domain to your Railway URL)
  const publicMainPath = path.join(__dirname, 'videos', `main-${timestamp}.mp4`);
  const publicBackgroundPath = path.join(__dirname, 'videos', `background-${timestamp}.mp4`);
  const publicMainUrl = `https://combine-video-production.up.railway.app/videos/main-${timestamp}.mp4`;
  const publicBackgroundUrl = `https://combine-video-production.up.railway.app/videos/background-${timestamp}.mp4`;
  
  try {
    // Download main video segment (with audio)
    const mainCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*${start}-${end}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
    console.log("Downloading main segment:", mainCmd);
    await new Promise((resolve, reject) => {
      exec(mainCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("Error downloading main segment:", stderr);
          return reject(new Error("Failed to download main segment."));
        }
        resolve();
      });
    });
    
    // Download background segment (video only)
    const bgCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*0-${duration}" -f "bestvideo[ext=mp4]" -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log("Downloading background segment:", bgCmd);
    await new Promise((resolve, reject) => {
      exec(bgCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("Error downloading background segment:", stderr);
          return reject(new Error("Failed to download background segment."));
        }
        resolve();
      });
    });
    
    // Re-encode main segment to lower quality (CRF 28)
    const ffmpegMainCmd = `ffmpeg -y -i "${mainSegmentPath}" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -c:a aac -b:a 128k "${reencodedMainPath}"`;
    console.log("Re-encoding main video:", ffmpegMainCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegMainCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg re-encoding error (main):", stderr);
          return reject(new Error("FFmpeg failed to re-encode main video."));
        }
        resolve();
      });
    });
    
    // Re-encode background segment to lower quality (CRF 28) - no audio needed.
    const ffmpegBgCmd = `ffmpeg -y -i "${backgroundSegmentPath}" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -an "${reencodedBackgroundPath}"`;
    console.log("Re-encoding background video:", ffmpegBgCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegBgCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg re-encoding error (background):", stderr);
          return reject(new Error("FFmpeg failed to re-encode background video."));
        }
        resolve();
      });
    });
    
    // Copy the re-encoded files to the public folder.
    await fs.copyFile(reencodedMainPath, publicMainPath);
    await fs.copyFile(reencodedBackgroundPath, publicBackgroundPath);
    console.log("Copied re-encoded files to public folder.");
    
    // Clean up temporary download and re-encoded files.
    await Promise.all([
      fs.unlink(mainSegmentPath),
      fs.unlink(backgroundSegmentPath),
      fs.unlink(reencodedMainPath),
      fs.unlink(reencodedBackgroundPath)
    ]);
    
    // Return the public URLs for main and background videos.
    res.json({
      clip_url: publicMainUrl,
      gameplay_url: publicMainUrl,
      background_url: publicBackgroundUrl
    });
  } catch (error) {
    console.error("Processing error:", error);
    res.status(500).json({ error: error.message });
    try {
      await Promise.all([
        fs.unlink(mainSegmentPath).catch(() => {}),
        fs.unlink(backgroundSegmentPath).catch(() => {}),
        fs.unlink(reencodedMainPath).catch(() => {}),
        fs.unlink(reencodedBackgroundPath).catch(() => {})
      ]);
    } catch (cleanupError) {
      console.error("Cleanup error after failure:", cleanupError);
    }
  }
});

/**
 * Endpoint: /extract-audio
 * (Remains unchanged from the previous version.)
 */
app.post('/extract-audio', async (req, res) => {
  const { mainUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  
  if (!mainUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({
      error: 'Invalid or missing fields: mainUrl, startSeconds, endSeconds.'
    });
  }
  
  const duration = end - start;
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const audioOutputPath = path.join(downloadsDir, `audio-${timestamp}.mp3`);
  
  try {
    const mainCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" -f bestaudio -o "${mainSegmentPath}" "${mainUrl}"`;
    console.log("Downloading audio stream:", mainCmd);
    await new Promise((resolve, reject) => {
      exec(mainCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("Error downloading audio stream:", stderr);
          return reject(new Error("Failed to download audio stream."));
        }
        resolve();
      });
    });
    
    const ffmpegCmd = `ffmpeg -y -ss ${start} -t ${duration} -i "${mainSegmentPath}" -avoid_negative_ts make_zero -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;
    console.log("Extracting audio with FFmpeg using input seeking:", ffmpegCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg audio extraction error:", stderr);
          return reject(new Error("FFmpeg failed to extract audio."));
        }
        resolve();
      });
    });
    
    res.sendFile(audioOutputPath, async (err) => {
      if (err) {
        console.error("Error sending file:", err);
        return res.status(500).json({ error: "Failed to send audio file." });
      }
      try {
        await Promise.all([
          fs.unlink(mainSegmentPath),
          fs.unlink(audioOutputPath)
        ]);
        console.log("Cleaned up temporary audio files.");
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
    });
  } catch (error) {
    console.error("Processing audio error:", error);
    res.status(500).json({ error: error.message });
    try {
      await Promise.all([
        fs.unlink(mainSegmentPath).catch(() => {}),
        fs.unlink(audioOutputPath).catch(() => {})
      ]);
    } catch (cleanupError) {
      console.error("Cleanup error after failure:", cleanupError);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

