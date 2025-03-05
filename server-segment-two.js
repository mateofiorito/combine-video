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
 * - Re-encodes each segment separately:
 *    - For the main video, we zoom in by scaling with a factor of 1.2 on the height:
 *          scale=iw*max(1080/iw,(960*1.2)/ih):ih*max(1080/iw,(960*1.2)/ih)
 *      then center-crop to exactly 1080×960.
 *    - For the background video, we scale to 1080x960 (using force_original_aspect_ratio=increase) and then center-crop.
 * - The re-encoded files are copied to a public folder.
 * - Returns a JSON object with separate URLs for the main video and the background video.
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
  
  // Re-encoded output file paths
  const mainReencodedPath = path.join(downloadsDir, `main-reencoded-${timestamp}.mp4`);
  const backgroundReencodedPath = path.join(downloadsDir, `background-reencoded-${timestamp}.mp4`);
  
  // Public folder paths and URLs using your Railway domain.
  const publicMainPath = path.join(__dirname, 'videos', `main-${timestamp}.mp4`);
  const publicBackgroundPath = path.join(__dirname, 'videos', `background-${timestamp}.mp4`);
  const publicMainUrl = `https://combine-video-production.up.railway.app/videos/main-${timestamp}.mp4`;
  const publicBackgroundUrl = `https://combine-video-production.up.railway.app/videos/background-${timestamp}.mp4`;
  
  try {
    // Download the main video segment (with audio) trimmed from startSeconds to endSeconds.
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

    // Download the background segment (video only) from 0 to the duration.
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

    // Re-encode the main segment to lower quality and apply extra zoom.
    const ffmpegMainCmd = `ffmpeg -y -i "${mainSegmentPath}" -filter_complex "fps=30,scale=iw*max(1080/iw\\,(960*1.2)/ih):ih*max(1080/iw\\,(960*1.2)/ih),crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -c:a aac -b:a 128k "${mainReencodedPath}"`;
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

    // Re-encode the background segment to lower quality.
    const ffmpegBgCmd = `ffmpeg -y -i "${backgroundSegmentPath}" -filter_complex "fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -an "${backgroundReencodedPath}"`;
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
    await fs.copyFile(mainReencodedPath, publicMainPath);
    await fs.copyFile(backgroundReencodedPath, publicBackgroundPath);
    console.log("Copied re-encoded files to public folder.");

    // Clean up temporary files.
    await Promise.all([
      fs.unlink(mainSegmentPath),
      fs.unlink(backgroundSegmentPath),
      fs.unlink(mainReencodedPath),
      fs.unlink(backgroundReencodedPath)
    ]);

    // Return the public URLs for main and background videos.
    res.json({
      main_video_url: publicMainUrl,
      background_video_url: publicBackgroundUrl
    });
  } catch (error) {
    console.error("Processing error:", error);
    res.status(500).json({ error: error.message });
    try {
      await Promise.all([
        fs.unlink(mainSegmentPath).catch(() => {}),
        fs.unlink(backgroundSegmentPath).catch(() => {}),
        fs.unlink(mainReencodedPath).catch(() => {}),
        fs.unlink(backgroundReencodedPath).catch(() => {})
      ]);
    } catch (cleanupError) {
      console.error("Cleanup error after failure:", cleanupError);
    }
  }
});

/**
 * Endpoint: /extract-audio
 * - Downloads the entire audio stream from the main video using yt-dlp.
 * - Uses FFmpeg to extract the segment from startSeconds to endSeconds.
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
    // Download the entire audio stream using bestaudio.
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
    
    // Use FFmpeg input seeking to extract exactly the desired audio segment.
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

