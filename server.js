const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Ensure the 'combined' folder exists
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
 * Expects a JSON body:
 * {
 *   "video1": "path/to/video1.mp4",
 *   "video2": "path/to/video2.mp4",
 *   "startSeconds": 180,  // start time in seconds
 *   "endSeconds": 300     // end time in seconds
 * }
 *
 * This endpoint uses ffmpeg to:
 * - Trim both input videos from startSeconds to endSeconds.
 * - Scale each trimmed video to 1920x540 (so that stacking them vertically yields 1920x1080).
 * - Stack the two scaled videos vertically.
 * - Return the combined video file.
 */
app.post('/combine', (req, res) => {
  const { video1, video2, startSeconds, endSeconds } = req.body;
  if (!video1 || !video2 || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: video1, video2, startSeconds, and endSeconds.' });
  }

  // Generate a unique output filename
  const outputFileName = `combined-${Date.now()}.mp4`;
  const outputFilePath = path.join(combinedDir, outputFileName);

  // Build the ffmpeg command:
  // - For each input, use -ss {startSeconds} to begin and -to {endSeconds} to end.
  // - Scale each trimmed video to 1920x540.
  // - Stack the two videos vertically using the vstack filter.
  // - Encode with libx264.
  const command = `ffmpeg -y -ss ${startSeconds} -to ${endSeconds} -i "${video1}" -ss ${startSeconds} -to ${endSeconds} -i "${video2}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
  
  console.log(`Executing command: ${command}`);
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing ffmpeg: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    
    console.log(`ffmpeg output: ${stdout}`);
    
    // Return the combined video file in the response.
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
