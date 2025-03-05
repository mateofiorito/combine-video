const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

// Serve the videos folder as static content.
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
  res.send('API for combining two YouTube videos is running!');
});

/**
 * Endpoint: /combine-two
 * - Downloads the main video segment (from startSeconds to endSeconds) and a background segment (from 0 until the duration of the main video).
 * - For the main video, we force an extra zoom by scaling with:
 *       scale=iw*max(1080/iw, (960*1.1)/ih):ih*max(1080/iw, (960*1.1)/ih)
 *   and then center-cropping to 1080x960.
 * - The background video is processed similarly.
 * - The two processed videos are then stacked vertically to produce a 1080x1920 output.
 * - The video is re-encoded with H.264 baseline, faststart, and explicit pixel format settings.
 * - The file is copied to a public folder, and its URL is returned.
 */
app.post('/combine-two', async (req, res) => {
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
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `background-${timestamp}.mp4`);
  const outputPath = path.join(downloadsDir, `combined-${timestamp}.mp4`);
  const publicPath = path.join(__dirname, 'videos', `combined-${timestamp}.mp4`);
  const publicUrl = `https://yourdomain.com/videos/combined-${timestamp}.mp4`;

  try {
    // Download main segment (video + audio)
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

    // Combine videos with FFmpeg.
    // Main video: Zoom with extra factor, then center-crop to 1080x960.
    // Background video: Process similarly (center-cropped).
    const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "\
[0:v]fps=30,scale=iw*max(1080/iw\\,(960*1.1)/ih):ih*max(1080/iw\\,(960*1.1)/ih),crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1[v0]; \
[1:v]fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1[v1]; \
[v0][v1]vstack=inputs=2,format=yuv420p[v]" -map "[v]" -map 0:a -c:v libx264 -profile:v baseline -preset veryfast -crf 23 -movflags +faststart -pix_fmt yuv420p -c:a aac -b:a 128k "${outputPath}"`;
    console.log("Combining videos with FFmpeg:", ffmpegCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg error:", stderr);
          return reject(new Error("FFmpeg failed to combine videos."));
        }
        resolve();
      });
    });

    // Copy the combined video to the public folder.
    await fs.copyFile(outputPath, publicPath);
    console.log("Copied combined video to public folder:", publicPath);

    // Clean up temporary files.
    await Promise.all([
      fs.unlink(mainSegmentPath),
      fs.unlink(backgroundSegmentPath),
      fs.unlink(outputPath)
    ]);

    // Return the public URL.
    res.json({ combined_video_url: publicUrl });

  } catch (error) {
    console.error("Processing error:", error);
    res.status(500).json({ error: error.message });
    try {
      await Promise.all([
        fs.unlink(mainSegmentPath).catch(() => {}),
        fs.unlink(backgroundSegmentPath).catch(() => {}),
        fs.unlink(outputPath).catch(() => {})
      ]);
    } catch (cleanupError) {
      console.error("Cleanup error after failure:", cleanupError);
    }
  }
});

/**
 * Endpoint: /extract-audio
 * (Remains unchanged.)
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
