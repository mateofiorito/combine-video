const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Create a "downloads" folder if it doesn’t exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.chmodSync(downloadsDir, '777'); // Adjust permissions as needed
}

app.get('/', (req, res) => {
  res.send('Combine-Two API for YouTube URLs is running!');
});

app.post('/combine-two', (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;

  // Convert startSeconds and endSeconds to numbers
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);

  // Debugging: Log the raw and parsed values
  console.log(`Raw startSeconds: ${startSeconds} (type: ${typeof startSeconds})`);
  console.log(`Raw endSeconds: ${endSeconds} (type: ${typeof endSeconds})`);
  console.log(`Parsed start: ${start}, Parsed end: ${end}`);

  // Validate input
  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end)) {
    return res.status(400).json({ error: 'Missing or invalid required fields: mainUrl, backgroundUrl, startSeconds, endSeconds.' });
  }
  if (start >= end) {
    return res.status(400).json({ error: 'startSeconds must be less than endSeconds' });
  }

  const timestamp = Date.now();
  const duration = end - start;
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Download main segment with video and audio using --download-sections
  const mainCmd = `yt-dlp --no-check-certificate --download-sections "*${start}-${end}" -f "best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Downloading main segment: ${mainCmd}`);
  exec(mainCmd, (errMain, stdoutMain, stderrMain) => {
    if (errMain) {
      console.error(`Error downloading main segment: ${errMain.message}`);
      return res.status(500).json({ error: errMain.message });
    }
    console.log(`Main segment downloaded: ${stdoutMain}`);

    // Download background segment with video only (no audio) using --download-sections
    const bgCmd = `yt-dlp --no-check-certificate --download-sections "*${start}-${end}" -f "bestvideo[acodec=none]" --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
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
