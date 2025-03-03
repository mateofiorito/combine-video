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
const cookiesPath = path.join(__dirname, 'youtube-cookies.txt'); // Add your cookies file path

(async () => {
  if (!await fs.access(downloadsDir).then(() => true).catch(() => false)) {
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.chmod(downloadsDir, '777');
  }
})();

app.get('/', (req, res) => {
  res.send('Combine-Two API for YouTube URLs is running!');
});

app.post('/combine-two', async (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;

  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);

  console.log(`Parsed start: ${start}, end: ${end}`);

  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ error: 'Invalid or missing fields: mainUrl, backgroundUrl, startSeconds, endSeconds.' });
  }

  const timestamp = Date.now();
  const duration = end - start;
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  try {
    // Download main segment (video + audio, like /download)
    const mainCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*${start}-${end}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
    console.log(`Executing main download: ${mainCmd}`);
    await new Promise((resolve, reject) => {
      exec(mainCmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`Main download stderr: ${stderr}`);
          return reject(new Error(`Main download failed: ${err.message}, stderr: ${stderr}`));
        }
        console.log(`Main download stdout: ${stdout}`);
        resolve();
      });
    });

    // Download background segment (video only, like /download-video-only)
    const bgCmd = `yt-dlp --no-check-certificate --cookies "${cookiesPath}" --download-sections "*${start}-${end}" -f "bestvideo[ext=mp4]" -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Executing background download: ${bgCmd}`);
    await new Promise((resolve, reject) => {
      exec(bgCmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`Background download stderr: ${stderr}`);
          return reject(new Error(`Background download failed: ${err.message}, stderr: ${stderr}`));
        }
        console.log(`Background download stdout: ${stdout}`);
        resolve();
      });
    });

    // Combine with FFmpeg
    const ffmpegCmd = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration=${duration}[v0];[1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration=${duration}[v1];[v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a -r 30 -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputFilePath}"`;
    console.log(`Executing FFmpeg: ${ffmpegCmd}`);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`FFmpeg stderr: ${stderr}`);
          return reject(new Error(`FFmpeg failed: ${err.message}, stderr: ${stderr}`));
        }
        console.log(`FFmpeg stdout: ${stdout}`);
        resolve();
      });
    });

    // Send file
    res.sendFile(outputFilePath, async (err) => {
      if (err) {
        console.error(`Send error: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
      await Promise.all([
        fs.unlink(mainSegmentPath).catch(() => {}),
        fs.unlink(backgroundSegmentPath).catch(() => {}),
        fs.unlink(outputFilePath).catch(() => {}),
      ]);
      console.log('File sent and cleaned up.');
    });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    res.status(500).json({ error: error.message });
    await Promise.all([
      fs.unlink(mainSegmentPath).catch(() => {}),
      fs.unlink(backgroundSegmentPath).catch(() => {}),
      fs.unlink(outputFilePath).catch(() => {}),
    ]);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
