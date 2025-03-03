const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Increase request timeout to 5 minutes
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  next();
});

// Create a "downloads" folder if it doesn’t exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.chmodSync(downloadsDir, '777'); // Ensure write permissions (adjust for production)
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
 * Downloads, processes, and combines two video segments, then cleans up files.
 */
app.post('/combine-two', (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  if (!mainUrl || !backgroundUrl || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: mainUrl, backgroundUrl, startSeconds, and endSeconds.' });
  }

  const timestamp = Date.now();
  const duration = endSeconds - startSeconds;
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Download main segment with video and audio
  const mainCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Downloading main segment: ${mainCmd}`);
  exec(mainCmd, (errMain, stdoutMain, stderrMain) => {
    if (errMain) {
      console.error(`Error downloading main segment: ${errMain.message}`);
      return res.status(500).json({ error: errMain.message });
    }
    console.log(`Main segment downloaded: ${stdoutMain}`);

    // Download background segment with video only (no audio)
    const bgCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo[acodec=none]" --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Downloading background segment: ${bgCmd}`);
    exec(bgCmd, (errBg, stdoutBg, stderrBg) => {
      if (errBg) {
        console.error(`Error downloading background segment: ${errBg.message}`);
        return res.status(500).json({ error: errBg.message });
      }
      console.log(`Background segment downloaded: ${stdoutBg}`);

      // Combine segments with FFmpeg, ensuring same duration
      const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1920:540,trim=duration=${duration}[v0]; [1:v]scale=1920:540,trim=duration=${duration}[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
      console.log(`Combining segments: ${ffmpegCmd}`);
      exec(ffmpegCmd, (errFmpeg, stdoutFfmpeg, stderrFfmpeg) => {
        // Clean up temporary segment files
        fs.unlink(mainSegmentPath, () => {});
        fs.unlink(backgroundSegmentPath, () => {});

        if (errFmpeg) {
          console.error(`Error combining segments: ${errFmpeg.message}`);
          return res.status(500).json({ error: errFmpeg.message });
        }
        console.log(`Segments combined: ${stdoutFfmpeg}`);

        // Send the combined file and clean up afterward
        res.sendFile(outputFilePath, (errSend) => {
          if (errSend) {
            console.error(`Error sending combined file: ${errSend.message}`);
            return res.status(500).json({ error: errSend.message });
          }
          console.log('Combined video file sent successfully.');
          // Clean up the output file after sending
          fs.unlink(outputFilePath, () => {});
        });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
