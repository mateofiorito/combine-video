const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Ensure the 'downloads' folder exists for temporary storage of downloaded segments
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

// Simple test endpoint
app.get('/', (req, res) => {
  res.send('Combine-Two API for YouTube URLs is running!');
});

/**
 * POST /combine-two
 * Expects a JSON body:
 * {
 *   "mainUrl": "https://www.youtube.com/watch?v=MAIN_VIDEO_ID",
 *   "backgroundUrl": "https://www.youtube.com/watch?v=BACKGROUND_VIDEO_ID",
 *   "startSeconds": 180,
 *   "endSeconds": 300
 * }
 *
 * This endpoint:
 * 1. Downloads a segment (from startSeconds to endSeconds) from the main video using yt-dlp (video+audio).
 * 2. Downloads a segment from the background video using yt-dlp (video only).
 * 3. Uses ffmpeg to scale both segments to 1920x540, then stacks them vertically (main on top, background on bottom).
 * 4. Maps the audio from the main segment.
 * 5. Returns the combined video file.
 */
app.post('/combine-two', (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  if (!mainUrl || !backgroundUrl || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: mainUrl, backgroundUrl, startSeconds, and endSeconds.' });
  }

  // Generate unique filenames for the segments
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Command to download the main video segment (video+audio)
  const mainCommand = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Executing mainCommand: ${mainCommand}`);

  exec(mainCommand, (errorMain, stdoutMain, stderrMain) => {
    if (errorMain) {
      console.error(`Error executing mainCommand: ${errorMain.message}`);
      return res.status(500).json({ error: errorMain.message });
    }
    console.log(`Main segment download output: ${stdoutMain}`);

    // Command to download the background video segment (video only)
    const backgroundCommand = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f bestvideo --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Executing backgroundCommand: ${backgroundCommand}`);

    exec(backgroundCommand, (errorBg, stdoutBg, stderrBg) => {
      if (errorBg) {
        console.error(`Error executing backgroundCommand: ${errorBg.message}`);
        return res.status(500).json({ error: errorBg.message });
      }
      console.log(`Background segment download output: ${stdoutBg}`);

      // Build ffmpeg command to combine the two segments:
      // - Scale each to 1920x540 so that when stacked vertically the result is 1920x1080.
      // - Use vstack to stack them (main on top, background on bottom).
      // - Map audio from the main segment (input index 0).
      const ffmpegCommand = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
      console.log(`Executing ffmpegCommand: ${ffmpegCommand}`);

      exec(ffmpegCommand, (errorFfmpeg, stdoutFfmpeg, stderrFfmpeg) => {
        // Clean up the temporary segment files regardless of success
        fs.unlink(mainSegmentPath, () => {});
        fs.unlink(backgroundSegmentPath, () => {});

        if (errorFfmpeg) {
          console.error(`Error executing ffmpegCommand: ${errorFfmpeg.message}`);
          return res.status(500).json({ error: errorFfmpeg.message });
        }
        console.log(`ffmpeg output: ${stdoutFfmpeg}`);

        // Optional delay to ensure file is fully written (adjust if needed)
        setTimeout(() => {
          if (!fs.existsSync(outputFilePath)) {
            console.error('Combined file does not exist at path:', outputFilePath);
            return res.status(500).json({ error: 'Combined file not found.' });
          }
          res.sendFile(outputFilePath, (err) => {
            if (err) {
              console.error('Error sending combined video file:', err);
              return res.status(500).json({ error: 'Error sending combined video file.' });
            } else {
              console.log('Combined video file sent successfully.');
            }
          });
        }, 3000);
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Combine-Two API is running on port ${PORT}`);
});
