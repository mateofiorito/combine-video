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
  res.send('Combine-Two API is running!');
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
 * Workflow:
 * 1. Download the segment from the main URL (video+audio) using yt-dlp.
 * 2. Download the segment from the background URL (video only) using yt-dlp.
 * 3. Use ffmpeg to trim (via -ss and -to), scale (to 1920x540), and stack the two videos vertically.
 *    Audio is mapped from the main video.
 * 4. Return the combined video file.
 */
app.post('/combine-two', (req, res) => {
  const requestId = Date.now();
  console.log(`Request ${requestId} received`);
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  if (!mainUrl || !backgroundUrl || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: mainUrl, backgroundUrl, startSeconds, and endSeconds.' });
  }

  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Download segment from mainUrl (video+audio)
  const mainCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Downloading main segment: ${mainCmd}`);
  exec(mainCmd, (errMain, stdoutMain, stderrMain) => {
    if (errMain) {
      console.error(`Error downloading main segment: ${errMain.message}`);
      return res.status(500).json({ error: errMain.message });
    }
    console.log(`Main segment downloaded: ${stdoutMain}`);

    // Download segment from backgroundUrl (video only)
    const bgCmd = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f bestvideo --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Downloading background segment: ${bgCmd}`);
    exec(bgCmd, (errBg, stdoutBg, stderrBg) => {
      if (errBg) {
        console.error(`Error downloading background segment: ${errBg.message}`);
        return res.status(500).json({ error: errBg.message });
      }
      console.log(`Background segment downloaded: ${stdoutBg}`);

      // Combine segments with ffmpeg:
      // - Scale each video to 1920x540.
      // - Stack them vertically (vstack), mapping audio from the main video.
      const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
      console.log(`Combining segments: ${ffmpegCmd}`);
      exec(ffmpegCmd, (errFfmpeg, stdoutFfmpeg, stderrFfmpeg) => {
        // Cleanup temporary files
        fs.unlink(mainSegmentPath, () => {});
        fs.unlink(backgroundSegmentPath, () => {});

        if (errFfmpeg) {
          console.error(`Error combining segments: ${errFfmpeg.message}`);
          return res.status(500).json({ error: errFfmpeg.message });
        }
        console.log(`Segments combined: ${stdoutFfmpeg}`);

        // Send the combined file in the response
        res.sendFile(outputFilePath, (errSend) => {
          if (errSend) {
            console.error(`Error sending combined file: ${errSend.message}`);
            return res.status(500).json({ error: errSend.message });
          }
          console.log('Combined video file sent successfully.');
        });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
