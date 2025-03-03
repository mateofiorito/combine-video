const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Ensure the downloads folder exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

// Simple test endpoint
app.get('/', (req, res) => {
  res.send('Download-Segment API is running!');
});

/**
 * POST /download-segment
 * Expects a JSON body:
 * {
 *   "url": "https://www.youtube.com/watch?v=VIDEO_ID",
 *   "startSeconds": 180,
 *   "endSeconds": 300
 * }
 * Downloads the segment (video+audio) from the YouTube URL between the given times,
 * then returns the resulting MP4 file.
 */
app.post('/download-segment', (req, res) => {
  const { url, startSeconds, endSeconds } = req.body;
  if (!url || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: url, startSeconds, and endSeconds.' });
  }

  // Generate a unique output filename
  const outputFilePath = path.join(downloadsDir, `segment-${Date.now()}.mp4`);

  // Build the ffmpeg command:
  // -ss and -to define the segment to download
  // -f "bestvideo+bestaudio/best" to download the best available streams
  // --merge-output-format mp4 forces merging to MP4
  const command = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;
  console.log(`Executing command: ${command}`);

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing yt-dlp for segment: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    console.log(`yt-dlp (segment) output: ${stdout}`);

    // Allow a delay to ensure the file is completely written before sending
    setTimeout(() => {
      if (!fs.existsSync(outputFilePath)) {
        console.error('Segment file does not exist at path:', outputFilePath);
        return res.status(500).json({ error: 'Downloaded segment file not found.' });
      }
      res.sendFile(outputFilePath, (err) => {
        if (err) {
          console.error('Error sending segment file:', err);
          return res.status(500).json({ error: 'Error sending segment file.' });
        } else {
          console.log('Segment file sent successfully.');
        }
      });
    }, 5000);
  });
});

app.listen(PORT, () => {
  console.log(`Download-Segment API is running on port ${PORT}`);
});
