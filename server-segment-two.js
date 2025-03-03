const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Create a "downloads" folder if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

app.get('/', (req, res) => {
  res.send('Combine-Two API for YouTube URLs is running!');
});

/**
 * POST /combine-two
 * Expects a JSON body:
 * {
 *   "mainUrl": "https://www.youtube.com/watch?v=MAIN_VIDEO_ID",
 *   "backgroundUrl": "https://www.youtube.com/watch?v=BACKGROUND_VIDEO_ID",
 *   "startSeconds": 32,
 *   "endSeconds": 45
 * }
 *
 * This endpoint:
 * 1. Downloads a segment from the main URL (video+audio) using yt-dlp with a format string that forces video.
 * 2. Downloads a segment from the background URL (video only).
 * 3. Uses ffmpeg to scale both segments to 1920x540 and stack them vertically (main on top, background on bottom) so the output is 1920x1080.
 * 4. Maps audio from the main segment.
 * 5. Returns the combined video file.
 */
app.post('/combine-two', (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  if (!mainUrl || !backgroundUrl || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: mainUrl, backgroundUrl, startSeconds, and endSeconds.' });
  }

  const timestamp = Date.now();
  const timeRange = `*${startSeconds}-${endSeconds}`;
  // Use a revised format string for the main segment:
  // Try to get the best video stream (with ext=mp4) and best audio (with ext=m4a) and merge them.
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Revised command for main segment with an explicit format string
  const mainCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Downloading main segment: ${mainCmd}`);
  exec(mainCmd, (errMain, stdoutMain, stderrMain) => {
    if (errMain) {
      console.error(`Error downloading main segment: ${errMain.message}`);
      return res.status(500).json({ error: errMain.message });
    }
    console.log(`Main segment downloaded: ${stdoutMain}`);

    // Command for background segment remains the same
    const bgCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f bestvideo --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Downloading background segment: ${bgCmd}`);
    exec(bgCmd, (errBg, stdoutBg, stderrBg) => {
      if (errBg) {
        console.error(`Error downloading background segment: ${errBg.message}`);
        return res.status(500).json({ error: errBg.message });
      }
      console.log(`Background segment downloaded: ${stdoutBg}`);

      // Combine segments with ffmpeg:
      // Scale each video to 1920x540, then stack vertically.
      // Map audio from the main segment.
      const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
      console.log(`Combining segments: ${ffmpegCmd}`);
      exec(ffmpegCmd, (errFfmpeg, stdoutFfmpeg, stderrFfmpeg) => {
        // Clean up temporary files
        fs.unlink(mainSegmentPath, () => {});
        fs.unlink(backgroundSegmentPath, () => {});

        if (errFfmpeg) {
          console.error(`Error combining segments: ${errFfmpeg.message}`);
          return res.status(500).json({ error: errFfmpeg.message });
        }
        console.log(`Segments combined: ${stdoutFfmpeg}`);
        res.sendFile(outputFilePath, (errSend) => {
          if (errSend) {
            console.error(`Error sending combined file: ${errSend.message}`);
            return res.status(500).json({ error: errSend.message });
          } else {
            console.log('Combined video file sent successfully.');
          }
        });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
