const express = require('express');
const { exec } = require('child_process');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads; files are temporarily stored in the 'uploads' folder
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(cors());

// Ensure the 'combined' folder exists (for output files)
const combinedDir = path.join(__dirname, 'combined');
if (!fs.existsSync(combinedDir)) {
  fs.mkdirSync(combinedDir);
}

// Simple test endpoint
app.get('/', (req, res) => {
  res.send('Video Combining API is running!');
});

/**
 * POST /combine
 * Expects a multipart/form-data request with fields:
 * - video1: binary file for first video
 * - video2: binary file for second video
 * - startSeconds: start time in seconds (number)
 * - endSeconds: end time in seconds (number)
 *
 * The endpoint:
 *   - Saves the uploaded files temporarily,
 *   - Uses ffmpeg to trim both videos from startSeconds to endSeconds,
 *   - Scales each video to 1920x540,
 *   - Stacks them vertically (one on top of the other) to create a 16:9 output,
 *   - Returns the combined video file.
 */
app.post('/combine', upload.fields([{ name: 'video1' }, { name: 'video2' }]), (req, res) => {
  const { startSeconds, endSeconds } = req.body;
  if (!req.files || !req.files.video1 || !req.files.video2) {
    return res.status(400).json({ error: 'Missing video files.' });
  }
  if (startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing startSeconds or endSeconds.' });
  }

  // Paths to the uploaded files
  const video1Path = req.files.video1[0].path;
  const video2Path = req.files.video2[0].path;

  // Generate a unique output filename
  const outputFileName = `combined-${Date.now()}.mp4`;
  const outputFilePath = path.join(combinedDir, outputFileName);

  // Build the ffmpeg command:
  // -ss: start time, -to: end time for each input video.
  // -filter_complex: scale each video to 1920x540 and stack them vertically (vstack).
  const command = `ffmpeg -y -ss ${startSeconds} -to ${endSeconds} -i "${video1Path}" -ss ${startSeconds} -to ${endSeconds} -i "${video2Path}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;

  console.log(`Executing command: ${command}`);

  exec(command, (error, stdout, stderr) => {
    // Delete the temporary uploaded files after processing
    fs.unlink(video1Path, () => {});
    fs.unlink(video2Path, () => {});

    if (error) {
      console.error(`Error executing ffmpeg: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }

    console.log(`ffmpeg output: ${stdout}`);
    res.sendFile(outputFilePath, (err) => {
      if (err) {
        console.error('Error sending combined video file:', err);
        return res.status(500).json({ error: 'Error sending combined video file.' });
      } else {
        console.log('Combined video file sent successfully.');
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
