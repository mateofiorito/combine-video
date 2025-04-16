const express = require('express');
const { promisify } = require('util');
const { exec: execCb } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');

const exec = promisify(execCb);
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

// Serve the 'videos' folder as static content.
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Ensure the downloads and videos directories exist.
const downloadsDir = path.join(__dirname, 'downloads');
(async () => {
  try {
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.chmod(downloadsDir, '777');
    await fs.mkdir(path.join(__dirname, 'videos'), { recursive: true });
  } catch (err) {
    console.error('Error creating directories:', err);
  }
})();

// Directory where your cookie files live
const cookiesDir = path.join(__dirname, 'youtube-cookies');

// Helper: get all cookie files
function getCookieFiles() {
  return fsSync.readdirSync(cookiesDir)
    .filter(f => /^youtube-cookies-\d+\.txt$/.test(f))
    .map(f => path.join(cookiesDir, f));
}

// Helper: detect cookie-related errors
function isCookieError(err, stderr = '') {
  const msg = (err.message + (stderr || '')).toLowerCase();
  return msg.includes('unable to load cookies')
      || msg.includes('cookie')
      || msg.includes('certificate')
      || msg.includes('403')
      || msg.includes('forbidden');
}

// Try running a yt-dlp command with each cookie file in turn.
// On cookie error, delete the bad cookie and retry with the next.
async function runWithRotatingCookies(commandBuilder) {
  let cookieFiles = getCookieFiles();
  for (const cookiePath of cookieFiles) {
    const cmd = commandBuilder(cookiePath);
    try {
      await exec(cmd);
      return; // success
    } catch (err) {
      if (isCookieError(err, err.stderr)) {
        try {
          fsSync.unlinkSync(cookiePath);
          console.warn(`Deleted bad cookie file: ${cookiePath}`);
        } catch (unlinkErr) {
          console.error(`Failed to delete cookie file ${cookiePath}:`, unlinkErr);
        }
        continue; // try next cookie
      }
      throw err; // non-cookie error
    }
  }
  throw new Error('No valid cookie files remaining');
}

app.get('/', (req, res) => {
  res.send('API for getting video URLs is running!');
});

app.post('/get-video-urls', async (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ error: 'Invalid or missing fields: mainUrl, backgroundUrl, startSeconds, endSeconds.' });
  }

  const duration = end - start;
  const timestamp = Date.now();

  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const backgroundSegmentPath = path.join(downloadsDir, `background-${timestamp}.mp4`);
  const mainReencodedPath = path.join(downloadsDir, `main-reencoded-${timestamp}.mp4`);
  const backgroundReencodedPath = path.join(downloadsDir, `background-reencoded-${timestamp}.mp4`);

  const publicMainPath = path.join(__dirname, 'videos', `main-${timestamp}.mp4`);
  const publicBackgroundPath = path.join(__dirname, 'videos', `background-${timestamp}.mp4`);
  const publicMainUrl = `https://combine-video-production.up.railway.app/videos/main-${timestamp}.mp4`;
  const publicBackgroundUrl = `https://combine-video-production.up.railway.app/videos/background-${timestamp}.mp4`;

  try {
    // Download main segment with rotating cookies
    console.log('Downloading main segment');
    await runWithRotatingCookies(cookiePath =>
      `yt-dlp --no-check-certificate --cookies "${cookiePath}" --download-sections "*${start}-${end}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${mainSegmentPath}" "${mainUrl}"`
    );

    // Download background segment with rotating cookies
    console.log('Downloading background segment');
    await runWithRotatingCookies(cookiePath =>
      `yt-dlp --no-check-certificate --cookies "${cookiePath}" --download-sections "*0-${duration}" -f "bestvideo[ext=mp4]" -o "${backgroundSegmentPath}" "${backgroundUrl}"`
    );

    // Re-encode main segment
    const ffmpegMainCmd = `ffmpeg -y -i "${mainSegmentPath}" -filter_complex "fps=30,scale=iw*max(1080/iw\\,(960*1.2)/ih):ih*max(1080/iw\\,(960*1.2)/ih),crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -c:a aac -b:a 128k "${mainReencodedPath}"`;
    console.log('Re-encoding main video');
    await exec(ffmpegMainCmd);

    // Re-encode background segment
    const ffmpegBgCmd = `ffmpeg -y -i "${backgroundSegmentPath}" -filter_complex "fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -an "${backgroundReencodedPath}"`;
    console.log('Re-encoding background video');
    await exec(ffmpegBgCmd);

    // Copy to public folder
    await fs.copyFile(mainReencodedPath, publicMainPath);
    await fs.copyFile(backgroundReencodedPath, publicBackgroundPath);
    console.log('Copied re-encoded files to public folder.');

    // Clean up
    await Promise.all([
      fs.unlink(mainSegmentPath),
      fs.unlink(backgroundSegmentPath),
      fs.unlink(mainReencodedPath),
      fs.unlink(backgroundReencodedPath)
    ]);

    res.json({ main_video_url: publicMainUrl, background_video_url: publicBackgroundUrl });
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: error.message });
    // Cleanup on failure
    await Promise.all([
      fs.unlink(mainSegmentPath).catch(() => {}),
      fs.unlink(backgroundSegmentPath).catch(() => {}),
      fs.unlink(mainReencodedPath).catch(() => {}),
      fs.unlink(backgroundReencodedPath).catch(() => {})
    ]);
  }
});

app.post('/extract-audio', async (req, res) => {
  const { mainUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  if (!mainUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ error: 'Invalid or missing fields: mainUrl, startSeconds, endSeconds.' });
  }

  const duration = end - start;
  const timestamp = Date.now();
  const mainSegmentPath = path.join(downloadsDir, `main-${timestamp}.mp4`);
  const audioOutputPath = path.join(downloadsDir, `audio-${timestamp}.mp3`);

  try {
    // Download audio stream with rotating cookies
    console.log('Downloading audio stream');
    await runWithRotatingCookies(cookiePath =>
      `yt-dlp --no-check-certificate --cookies "${cookiePath}" -f bestaudio -o "${mainSegmentPath}" "${mainUrl}"`
    );

    // Extract audio segment
    const ffmpegCmd = `ffmpeg -y -ss ${start} -t ${duration} -i "${mainSegmentPath}" -avoid_negative_ts make_zero -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;
    console.log('Extracting audio with FFmpeg');
    await exec(ffmpegCmd);

    res.sendFile(audioOutputPath, async (err) => {
      if (err) {
        console.error('Error sending file:', err);
        return res.status(500).json({ error: 'Failed to send audio file.' });
      }
      // Cleanup
      await Promise.all([
        fs.unlink(mainSegmentPath),
        fs.unlink(audioOutputPath)
      ]);
      console.log('Cleaned up temporary audio files.');
    });
  } catch (error) {
    console.error('Processing audio error:', error);
    res.status(500).json({ error: error.message });
    await Promise.all([
      fs.unlink(mainSegmentPath).catch(() => {}),
      fs.unlink(audioOutputPath).catch(() => {})
    ]);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
