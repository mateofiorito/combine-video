const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');  // For generating unique job IDs

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Directory for storing downloaded/combined files
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

// In-memory job store (for demo purposes; use a DB in production)
const jobs = {};

/**
 * POST /submit-job
 * Expects JSON body:
 * {
 *   "mainUrl": "https://www.youtube.com/watch?v=MAIN_VIDEO_ID",
 *   "backgroundUrl": "https://www.youtube.com/watch?v=BACKGROUND_VIDEO_ID",
 *   "startSeconds": 180,
 *   "endSeconds": 300
 * }
 *
 * Immediately returns a job ID, and processes the job asynchronously.
 */
app.post('/submit-job', (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  if (!mainUrl || !backgroundUrl || startSeconds === undefined || endSeconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields: mainUrl, backgroundUrl, startSeconds, endSeconds.' });
  }

  const jobId = uuidv4();
  jobs[jobId] = { status: 'queued', outputFile: null, error: null };
  res.json({ jobId });

  // Process the job asynchronously:
  processJob(jobId, mainUrl, backgroundUrl, startSeconds, endSeconds);
});

/**
 * GET /job-status/:jobId
 * Returns the status of a job.
 */
app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  res.json(jobs[jobId]);
});

/**
 * Function to process the video job asynchronously.
 */
function processJob(jobId, mainUrl, backgroundUrl, startSeconds, endSeconds) {
  // Update job status
  jobs[jobId].status = 'processing';
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `mainSegment-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `backgroundSegment-${timestamp}.mp4`);
  const outputFilePath = path.join(downloadsDir, `combined-${timestamp}.mp4`);

  // Download main segment (video+audio)
  const mainCommand = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`;
  console.log(`Job ${jobId}: Executing mainCommand: ${mainCommand}`);
  exec(mainCommand, (errorMain, stdoutMain, stderrMain) => {
    if (errorMain) {
      console.error(`Job ${jobId}: Error executing mainCommand: ${errorMain.message}`);
      jobs[jobId].status = 'failed';
      jobs[jobId].error = errorMain.message;
      return;
    }
    console.log(`Job ${jobId}: Main segment downloaded.`);

    // Download background segment (video only)
    const backgroundCommand = `yt-dlp --no-check-certificate -ss ${startSeconds} -to ${endSeconds} -f bestvideo --merge-output-format mp4 -o "${backgroundSegmentPath}" "${backgroundUrl}"`;
    console.log(`Job ${jobId}: Executing backgroundCommand: ${backgroundCommand}`);
    exec(backgroundCommand, (errorBg, stdoutBg, stderrBg) => {
      if (errorBg) {
        console.error(`Job ${jobId}: Error executing backgroundCommand: ${errorBg.message}`);
        jobs[jobId].status = 'failed';
        jobs[jobId].error = errorBg.message;
        return;
      }
      console.log(`Job ${jobId}: Background segment downloaded.`);

      // Combine segments using ffmpeg:
      const ffmpegCommand = `ffmpeg -y -i "${mainSegmentPath}" -i "${backgroundSegmentPath}" -filter_complex "[0:v]scale=1920:540[v0]; [1:v]scale=1920:540[v1]; [v0][v1]vstack=inputs=2[v]" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 "${outputFilePath}"`;
      console.log(`Job ${jobId}: Executing ffmpegCommand: ${ffmpegCommand}`);
      exec(ffmpegCommand, (errorFfmpeg, stdoutFfmpeg, stderrFfmpeg) => {
        // Clean up the temporary segment files
        fs.unlink(mainSegmentPath, () => {});
        fs.unlink(backgroundSegmentPath, () => {});

        if (errorFfmpeg) {
          console.error(`Job ${jobId}: Error executing ffmpegCommand: ${errorFfmpeg.message}`);
          jobs[jobId].status = 'failed';
          jobs[jobId].error = errorFfmpeg.message;
          return;
        }
        console.log(`Job ${jobId}: ffmpeg processing complete.`);
        jobs[jobId].status = 'completed';
        jobs[jobId].outputFile = outputFilePath;
      });
    });
  });
}

/**
 * GET /download-job/:jobId
 * Once a job is completed, this endpoint returns the combined video file.
 */
app.get('/download-job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Job not completed yet.' });
  }
  res.sendFile(job.outputFile, (err) => {
    if (err) {
      console.error(`Error sending file for job ${jobId}:`, err);
      res.status(500).json({ error: 'Error sending combined video file.' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Job Processing API is running on port ${PORT}`);
});
