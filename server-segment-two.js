const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

const downloadsDir = path.join(__dirname, 'downloads');
const cookiesPath = path.join(__dirname, 'youtube-cookies.txt'); // Set your cookies file path here

// Ensure the downloads directory exists and is accessible
(async () => {
  try {
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.chmod(downloadsDir, '777');
  } catch (error) {
    console.error('Error setting up downloads directory:', error);
  }
})();

app.get('/', (req, res) => {
  res.send('API for combining two YouTube videos is running!');
});

app.post('/combine-two', async (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);

  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({
      error: 'Invalid or missing fields: mainUrl, backgroundUrl, startSeconds, endSeconds.'
    });
  }

  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `background-${timestamp}.mp4`);
  const outputPath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  try {
    // Download the main video segment (video + audio)
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

    // Download the background video segment (video only)
    const bgCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*${start}-${end}" -f "bestvideo[ext=mp4]" -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
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

    // Combine the two videos using FFmpeg.
    // Each video is scaled and padded to 1080x960 so that stacking vertically creates a 1080x1920 output.
    // The audio is taken from the main video only.
    const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]; [1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
    console.log("Combining videos with FFmpeg:", ffmpegCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("Error combining videos:", stderr);
          return reject(new Error("FFmpeg failed to combine videos."));
        }
        resolve();
      });
    });

    // Send the resulting file and clean up temporary files after sending
    res.sendFile(outputPath, async (err) => {
      if (err) {
        console.error("Error sending file:", err);
        return res.status(500).json({ error: "Failed to send output file." });
      }
      try {
        await Promise.all([
          fs.unlink(mainSegmentPath),
          fs.unlink(backgroundSegmentPath),
          fs.unlink(outputPath)
        ]);
        console.log("Cleaned up temporary files.");
      } catch (cleanupError) {
        console.error("Error cleaning up temporary files:", cleanupError);
      }
    });
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
      console.error("Error cleaning up after failure:", cleanupError);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
