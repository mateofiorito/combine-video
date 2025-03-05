const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

const downloadsDir = path.join(__dirname, 'downloads');
const cookiesPath = path.join(__dirname, 'youtube-cookies.txt'); // Set your cookies file path

// Ensure the downloads directory exists
(async () => {
  try {
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.chmod(downloadsDir, '777');
  } catch (err) {
    console.error('Error creating downloads directory:', err);
  }
})();

app.get('/', (req, res) => {
  res.send('API for combining two YouTube videos is running!');
});

/**
 * Endpoint: /combine-two
 * - Downloads the main video segment (from startSeconds to endSeconds) and a background segment (from 0 until the duration of the main video).
 * - Processes both videos by forcing them to cover a 1080x960 area via scaling with "force_original_aspect_ratio=increase" and center cropping.
 * - The processed videos are then stacked vertically to produce a 1080x1920 output.
 * - The audio is taken from the main video.
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

  // Calculate the duration for the main video segment.
  const duration = end - start;
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `background-${timestamp}.mp4`);
  const outputPath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  try {
    // Download the main segment (video + audio) using the provided start and end seconds.
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

    // Download the background segment (video only) from second 0 until the duration of the main video.
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

    // Combine the two videos using FFmpeg.
    // For each input:
    //  - Force 30 fps.
    //  - Scale with force_original_aspect_ratio=increase to ensure the video covers at least 1080x960.
    //  - Center crop explicitly with crop=1080:960:(in_w-1080)/2:(in_h-960)/2.
    //  - Set SAR to 1.
    // Then stack them vertically (vstack) to produce a 1080x1920 output.
    const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1[v0]; [1:v]fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1[v1]; [v0][v1]vstack=inputs=2,format=yuv420p[v]" -map "[v]" -map 0:a -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
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

    // Send the resulting file and clean up temporary files
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
        console.error("Cleanup error:", cleanupError);
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
      console.error("Cleanup error after failure:", cleanupError);
    }
  }
});

/**
 * Endpoint: /extract-audio
 * - Downloads the main video segment (from startSeconds to endSeconds) as an audio-only file.
 * - Uses FFmpeg to extract, trim, and resample the audio to an MP3 file.
 * - This helps correct any timestamp mismatches so that the audio aligns with the video.
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

  // Calculate the duration for the audio segment.
  const duration = end - start;
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const audioOutputPath = path.join(downloadsDir, `audio-${timestamp}.mp3`);

  try {
    // Download only the audio from the main video segment.
    // We use the bestaudio format to get an audio-only file.
    const mainCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*${start}-${end}" -f bestaudio -o "${mainSegmentPath}" "${mainUrl}"`;
    console.log("Downloading audio segment:", mainCmd);
    await new Promise((resolve, reject) => {
      exec(mainCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("Error downloading audio segment:", stderr);
          return reject(new Error("Failed to download audio segment."));
        }
        resolve();
      });
    });

    // Extract audio, trim it to the exact duration, and resample to correct timing.
    // The atrim filter ensures the output is exactly 'duration' seconds.
    // asetpts resets the presentation timestamps.
    // aresample=async=1 helps adjust the audio stream to avoid small timestamp mismatches.
    const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -filter:a "atrim=start=0:duration=${duration},asetpts=PTS-STARTPTS,aresample=async=1" -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;
    console.log("Extracting and trimming audio with FFmpeg:", ffmpegCmd);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg audio extraction error:", stderr);
          return reject(new Error("FFmpeg failed to extract audio."));
        }
        resolve();
      });
    });

    // Send the resulting MP3 file and clean up temporary files
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
