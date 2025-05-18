// At the very top, disable strict TLS checks if needed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const { promisify } = require('util');
const { exec: execCb } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const exec = promisify(execCb);

// Fallback download libraries
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const puppeteer = require('puppeteer');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(cors());

// Serve static videos
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Ensure directories exist
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

// -- COOKIE ROTATION HELPERS --
const cookiesDir = path.join(__dirname, 'youtube-cookies');
function getCookieFiles() {
  return fsSync.readdirSync(cookiesDir)
    .filter(f => /^youtube-cookies-\d+\.txt$/.test(f))
    .map(f => path.join(cookiesDir, f));
}
function isCookieError(err, stderr = '') {
  const msg = (err.message + stderr).toLowerCase();
  return msg.includes('unable to load cookies')
      || msg.includes('cookie')
      || msg.includes('certificate')
      || msg.includes('403')
      || msg.includes('forbidden');
}
async function runWithRotatingCookies(commandBuilder) {
  let cookieFiles = getCookieFiles();
  for (const cookiePath of cookieFiles) {
    const cmd = commandBuilder(cookiePath);
    try {
      await exec(cmd);
      return;
    } catch (err) {
      if (isCookieError(err, err.stderr)) {
        try {
          fsSync.unlinkSync(cookiePath);
          console.warn(`Deleted bad cookie file: ${cookiePath}`);
        } catch (unlinkErr) {
          console.error(`Failed to delete cookie file ${cookiePath}:`, unlinkErr);
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error('No valid cookie files remaining');
}

// -- UTILITY FUNCTIONS --
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

async function retryOperation(fn, maxRetries = 3, baseDelay = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random());
      console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying in ${Math.round(delay)} ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// -- DOWNLOAD ENGINES --
async function downloadWithYtdl(url, outputPath, opts = {}) {
  const stream = ytdl(url, opts);
  return new Promise((resolve, reject) => {
    const ws = fsSync.createWriteStream(outputPath);
    stream.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    stream.on('error', reject);
  });
}

async function downloadWithPuppeteer(videoId, outputPath) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'networkidle2' });
    const src = await page.$eval('video', v => v.src);
    const resp = await axios.get(src, { responseType: 'stream', timeout: 60000 });
    return new Promise((res, rej) => {
      const ws = fsSync.createWriteStream(outputPath);
      resp.data.pipe(ws);
      ws.on('finish', res);
      ws.on('error', rej);
    });
  } finally {
    await browser.close();
  }
}

async function downloadWithAxiosScrape(videoId, outputPath) {
  const pageResp = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
  const match = pageResp.data.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
  if (!match) throw new Error('Could not parse playerResponse');
  const player = JSON.parse(match[1]);
  const urlObj = player.streamingData.formats[0].url;
  const resp = await axios.get(urlObj, { responseType: 'stream' });
  return new Promise((res, rej) => {
    const ws = fsSync.createWriteStream(outputPath);
    resp.data.pipe(ws);
    ws.on('finish', res);
    ws.on('error', rej);
  });
}

async function downloadWithYtDlp(url, outputPath) {
  return runWithRotatingCookies(cookiePath =>
    `yt-dlp --no-check-certificate --cookies "${cookiePath}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`
  );
}

// -- UNIFIED DOWNLOAD SEGMENT --
async function downloadSegment(url, outputPath, opts = {}) {
  const videoId = extractVideoId(url);
  // 1) ytdl-core
  try {
    console.log('Downloading with ytdl-core');
    return await retryOperation(() => downloadWithYtdl(url, outputPath, opts));
  } catch (err) {
    console.warn('ytdl-core failed:', err.message);
  }
  // 2) Puppeteer
  if (videoId) {
    try {
      console.log('Downloading with Puppeteer');
      return await retryOperation(() => downloadWithPuppeteer(videoId, outputPath));
    } catch (err) {
      console.warn('Puppeteer fallback failed:', err.message);
    }
  }
  // 3) Axios scrape
  if (videoId) {
    try {
      console.log('Downloading with Axios scrape');
      return await retryOperation(() => downloadWithAxiosScrape(videoId, outputPath));
    } catch (err) {
      console.warn('Axios scrape fallback failed:', err.message);
    }
  }
  // 4) yt-dlp + rotating cookies
  console.log('Downloading with yt-dlp fallback');
  return downloadWithYtDlp(url, outputPath);
}

// -- ROUTES --
app.get('/', (req, res) => res.send('API for getting video URLs is running!'));

app.post('/get-video-urls', async (req, res) => {
  const { mainUrl, backgroundUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  if (!mainUrl || !backgroundUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ error: 'Invalid fields.' });
  }
  const duration = end - start;
  const ts = Date.now();

  const mainSegment = path.join(downloadsDir, `main-${ts}.mp4`);
  const bgSegment   = path.join(downloadsDir, `background-${ts}.mp4`);
  const mainRe      = path.join(downloadsDir, `main-reencoded-${ts}.mp4`);
  const bgRe        = path.join(downloadsDir, `background-reencoded-${ts}.mp4`);
  const publicDir   = path.join(__dirname, 'videos');

  try {
    console.log('→ Download main segment');
    await downloadSegment(mainUrl, mainSegment, { downloadSections: `*${start}-${end}` });

    console.log('→ Download background segment');
    await downloadSegment(backgroundUrl, bgSegment, { downloadSections: `*0-${duration}`, format: 'bestvideo[ext=mp4]' });

    console.log('→ Re-encode main');
    await exec(`ffmpeg -y -i "${mainSegment}" -filter_complex "fps=30,scale=iw*max(1080/iw\\,(960*1.2)/ih):ih*max(1080/iw\\,(960*1.2)/ih),crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -c:a aac -b:a 128k "${mainRe}"`);

    console.log('→ Re-encode background');
    await exec(`ffmpeg -y -i "${bgSegment}" -filter_complex "fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1" -c:v libx264 -profile:v baseline -preset veryfast -crf 28 -movflags +faststart -pix_fmt yuv420p -an "${bgRe}"`);

    // Copy to public
    await fs.copyFile(mainRe, path.join(publicDir, `main-${ts}.mp4`));
    await fs.copyFile(bgRe,   path.join(publicDir, `background-${ts}.mp4`));

    // Cleanup
    await Promise.all([fs.unlink(mainSegment), fs.unlink(bgSegment), fs.unlink(mainRe), fs.unlink(bgRe)]);

    res.json({
      main_video_url: `/videos/main-${ts}.mp4`,
      background_video_url: `/videos/background-${ts}.mp4`
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
    await Promise.all([fs.unlink(mainSegment).catch(() => {}), fs.unlink(bgSegment).catch(() => {}), fs.unlink(mainRe).catch(() => {}), fs.unlink(bgRe).catch(() => {})]);
  }
});

app.post('/extract-audio', async (req, res) => {
  const { mainUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  if (!mainUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ error: 'Invalid fields.' });
  }
  const duration = end - start;
  const ts = Date.now();
  const segment = path.join(downloadsDir, `main-${ts}.mp4`);
  const audio   = path.join(downloadsDir, `audio-${ts}.mp3`);

  try {
    console.log('→ Download audio segment');
    await downloadSegment(mainUrl, segment, { format: 'bestaudio' });

    console.log('→ Extract audio');
    await exec(`ffmpeg -y -ss ${start} -t ${duration} -i "${segment}" -avoid_negative_ts make_zero -vn -acodec libmp3lame -q:a 2 "${audio}"`);

    res.sendFile(audio, async err => {
      if (err) return res.status(500).json({ error: 'Failed to send audio.' });
      await Promise.all([fs.unlink(segment), fs.unlink(audio)]);
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
    await Promise.all([fs.unlink(segment).catch(() => {}), fs.unlink(audio).catch(() => {})]);
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
