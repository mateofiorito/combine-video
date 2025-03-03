const express = require('express');
const { exec } = require('child_process');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer to store uploaded files in the 'uploads' folder
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(cors());

// Ensure the 'combined' folder exists for the output file
const combinedDir = path.join(__dirname, 'combined');
if (!fs.existsSync(combinedDir)) {
  fs.mkdirSync(combinedDir);
}

// Simple test endpoint
app.get('/', (req, res) => {
  res.send('Combine-Two API is running!');
});

/**
 * POST /combine-two
 * Expects a multipart/form-data request with fields:
 * - main: The main video file (with video+audio) in MP4 format.
 * - background: The background video file (video only) in MP4 format.
 * - startSeconds: (text) start time in seconds.
 * - endSeconds: (text) end time in seconds.
 *
 * The endpoint uses ffmpeg to:
 *   1. Trim both videos from startSeconds to endSeconds.
 *   2. For the main video, preserve video and audio.
 *   3. For the background video, use only the video stream.
 *   4. Scale both videos to 1920x540.
 *   5. Stack them vertically (main on top, background on bottom) to form a 1920x1080 output.
 *   6. Map audio from the main video.
 *   7. Return the combined video file.
 */
app.post('/combine-two', upload.fields([{ name: 'main' }, { name: 'background' }]), (req, res) => {
  const { startSeconds, endSeconds } = req.body;
  if (!req.files || !req.files.main || !req.files.background) {
    return res.status(400).json({ error: 'Missing required video files: main and background.' });
  }
  if (startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: startSeconds and endSeconds.' });
  }

  // Paths to the uploaded files
  const mainPath = req.files.main[0].path;
  const backgroundPath = req.files.background[0].path;

  // Generate a unique output filename
  const outputFileName = `combined-${Date.now()}.mp4`;
  const outputFilePath = path.join(combinedDir, outputFileName);

  // Build the ffmpeg command:
  // For each input, we use -ss to seek to startSeconds and -to to stop at endSeconds.
  // For the main video, we take both video and audio.
  // For the background video, we only take the video stream.
  // We scale each to 1920x540 so that when stacked vertically (vstack) they form 1920x1080.
  // We then map the audio from the main input (0:a) if available.
  const command = `ffmpeg -y -ss ${startSeconds} -to ${endSeconds} -i "${mainPath}" -ss ${startSeconds} -to ${endSeconds} -i "${backgroundPath}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
  
  console.log(`Executing command: ${command}`);
  
  exec(command, (error, stdout, stderr) => {
    // Clean up the temporary uploaded files
    fs.unlink(mainPath, () => {});
    fs.unlink(backgroundPath, () => {});

    if (error) {
      console.error(`Error executing ffmpeg: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    
    console.log(`ffmpeg output: ${stdout}`);
    
    // Optionally add a small delay if needed
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

app.listen(PORT, () => {
  console.log(`Combine-Two API is running on port ${PORT}`);
});
