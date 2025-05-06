const express = require('express');
const { promisify } = require('util');
const { exec: execCb } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const exec = promisify(execCb);
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

// Serve the 'videos' folder as static content
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Ensure directories exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'videos'))) fs.mkdirSync(path.join(__dirname, 'videos'), { recursive: true });

// BrightData configuration
const BRIGHTDATA_CONFIG = {
  username: process.env.BRIGHTDATA_USERNAME || 'brd-customer-hl_1907e8f2',
  password: process.env.BRIGHTDATA_PASSWORD || '1n3umzsuqe1r',
  zone: 'residential_proxy1',
  country: process.env.BRIGHTDATA_COUNTRY || 'us',
  session_id: () => Math.floor(Math.random() * 1000000),
  host: process.env.BRIGHTDATA_HOST || 'brd.superproxy.io',
  port: process.env.BRIGHTDATA_PORT || 33335
};

// Enhanced proxy URL generator
function getBrightDataProxyUrl() {
  const sessionId = BRIGHTDATA_CONFIG.session_id();
  console.log(`Creating new BrightData proxy session: ${sessionId}`);

  const proxyUrl = `http://${BRIGHTDATA_CONFIG.username}-${BRIGHTDATA_CONFIG.zone}-${BRIGHTDATA_CONFIG.country}-${sessionId}:${BRIGHTDATA_CONFIG.password}@${BRIGHTDATA_CONFIG.host}:${BRIGHTDATA_CONFIG.port}`;
  
  return proxyUrl;
}

// Enhanced browser fingerprinting function
function createBrowserLikeHeaders() {
  // Major browser versions
  const chromeVersions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0'];
  const buildIds = ['m101', 'm102', 'm105', 'r123456'];
  const safariVersions = ['537.36', '602.1.50', '605.1.15'];
  const windowsVersions = ['10.0', '11.0'];
  
  // Randomly select versions
  const chromeVersion = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
  const majorVersion = chromeVersion.split('.')[0];
  const buildId = buildIds[Math.floor(Math.random() * buildIds.length)];
  const safariVersion = safariVersions[Math.floor(Math.random() * safariVersions.length)];
  const windowsVersion = windowsVersions[Math.floor(Math.random() * windowsVersions.length)];
  
  // Create headers that fully mimic a real browser
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT ${windowsVersion}; Win64; x64) AppleWebKit/${safariVersion} (KHTML, like Gecko) Chrome/${chromeVersion} Safari/${safariVersion}`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.google.com/',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': `"Not-A.Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'X-Client-Data': `${Buffer.from(`CIi2yQEIo7bJAQipncoBCKijygEI${buildId}`).toString('base64')}`,
    'Connection': 'keep-alive'
  };
}

// Create proxied ytdl
async function createProxiedYtdl(url, options = {}) {
  const proxyUrl = getBrightDataProxyUrl();
  const sanitizedUrl = proxyUrl.replace(/:[^:]*@/, ':****@');
  console.log(`Using proxy: ${sanitizedUrl}`);

  // Create realistic cookies
  const cookies = [
    {
      name: 'CONSENT',
      value: 'YES+cb.20220419-11-p0.en+FX+' + Math.floor(Math.random() * 1000),
      domain: '.youtube.com',
      path: '/',
      httpOnly: true,
      secure: true
    },
    {
      name: 'VISITOR_INFO1_LIVE',
      value: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
      domain: '.youtube.com',
      path: '/',
      httpOnly: true,
      secure: true
    },
    {
      name: 'YSC',
      value: Math.random().toString(36).substring(2, 15),
      domain: '.youtube.com',
      path: '/',
      httpOnly: true,
      secure: true
    },
    {
      name: 'PREF',
      value: `f4=${Math.floor(Math.random() * 10000)}000&hl=en&f5=30000`,
      domain: '.youtube.com',
      path: '/',
      httpOnly: false,
      secure: true
    }
  ];
  
  // Create a custom client with cookies
  const requestWithProxy = ytdl.createAgent(cookies);
  
  // Apply browser-like headers
  requestWithProxy.headers = createBrowserLikeHeaders();
  
  // Set the correct proxy URL
  requestWithProxy.proxyURL = proxyUrl;
  
  // Return a proxy-enabled stream
  return ytdl(url, {
    ...options,
    client: requestWithProxy
  });
}

// Create a proxy rotation pool
const proxyPool = {
  agents: [],
  maxAgents: 5,
  currentIndex: 0,
  
  getAgent() {
    if (this.agents.length < this.maxAgents) {
      const proxyUrl = getBrightDataProxyUrl();
      this.agents.push({
        agent: new HttpsProxyAgent(proxyUrl),
        proxyUrl,
        created: Date.now(),
        uses: 0
      });
    }
    
    const agentData = this.agents[this.currentIndex];
    agentData.uses++;
    
    this.currentIndex = (this.currentIndex + 1) % this.agents.length;
    
    // Refresh agent if it's been used too much or is too old
    if (agentData.uses > 50 || (Date.now() - agentData.created) > 10 * 60 * 1000) {
      const proxyUrl = getBrightDataProxyUrl();
      agentData.agent = new HttpsProxyAgent(proxyUrl);
      agentData.proxyUrl = proxyUrl;
      agentData.created = Date.now();
      agentData.uses = 0;
    }
    
    return agentData;
  }
};

// Retry function with exponential backoff
async function retryOperation(operation, maxRetries = 3, initialDelay = 2000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries}...`);
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random());
        console.log(`Retrying in ${Math.round(delay / 1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        console.log('Rotating proxy for next attempt');
        proxyPool.currentIndex = (proxyPool.currentIndex + 1) % proxyPool.agents.length;
      }
    }
  }
  
  throw lastError;
}

// Function to validate YouTube video ID
function validateVideoId(videoId) {
  return typeof videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

// Function to construct YouTube URL from ID
function getYoutubeUrlFromId(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Download video stream
async function downloadVideoStream(videoId, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const url = getYoutubeUrlFromId(videoId);
      
      // Get a proxied ytdl stream
      const videoStream = await createProxiedYtdl(url, {
        filter: 'videoonly',
        quality: 'highestvideo'
      });
      
      const videoFile = fs.createWriteStream(outputPath);
      videoStream.pipe(videoFile);
      
      videoStream.on('error', (err) => {
        console.error('Video stream error:', err);
        reject(err);
      });
      
      videoFile.on('finish', () => {
        console.log('Video download complete');
        resolve();
      });
      
      videoFile.on('error', (err) => {
        console.error('Video file write error:', err);
        reject(err);
      });
    } catch (err) {
      console.error('Could not create video stream:', err);
      reject(err);
    }
  });
}

// Download audio stream
async function downloadAudioStream(videoId, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const url = getYoutubeUrlFromId(videoId);
      
      // Get a proxied ytdl stream
      const audioStream = await createProxiedYtdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio'
      });
      
      // Convert to mp3 with ffmpeg
      const ffmpegProcess = ffmpeg(audioStream)
        .audioBitrate(128)
        .toFormat('mp3')
        .save(outputPath);
      
      ffmpegProcess.on('end', () => {
        console.log('Audio download complete');
        resolve();
      });
      
      ffmpegProcess.on('error', (err) => {
        console.error('Audio conversion error:', err);
        reject(err);
      });
    } catch (err) {
      console.error('Could not create audio stream:', err);
      reject(err);
    }
  });
}

app.get('/', (req, res) => {
  res.send('API for getting video URLs is running!');
});

// Main endpoint to get video URLs - updated to use videoId
app.post('/get-video-urls', async (req, res) => {
  const { mainVideoId, backgroundVideoId, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  
  // Validate inputs
  if (!validateVideoId(mainVideoId) || !validateVideoId(backgroundVideoId)) {
    return res.status(400).json({ 
      error: 'Invalid video IDs. Both mainVideoId and backgroundVideoId must be valid YouTube video IDs (11 characters).' 
    });
  }
  
  if (isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ 
      error: 'Invalid time range. startSeconds must be less than endSeconds.' 
    });
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
    // Download main video
    console.log('Downloading main video...');
    await retryOperation(async () => {
      // Download video and audio separately and merge
      const mainVideoPath = path.join(downloadsDir, `main-video-${timestamp}.mp4`);
      const mainAudioPath = path.join(downloadsDir, `main-audio-${timestamp}.mp3`);
      
      // Download video stream
      await downloadVideoStream(mainVideoId, mainVideoPath);
      
      // Download audio stream
      await downloadAudioStream(mainVideoId, mainAudioPath);
      
      // Verify downloads were successful
      if (fs.statSync(mainVideoPath).size === 0) throw new Error("Downloaded main video is empty");
      if (fs.statSync(mainAudioPath).size === 0) throw new Error("Downloaded main audio is empty");
      
      // Merge video and audio
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(mainVideoPath)
          .input(mainAudioPath)
          .outputOptions(['-c:v copy', '-c:a aac'])
          .output(mainSegmentPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      // Clean up
      fs.unlinkSync(mainVideoPath);
      fs.unlinkSync(mainAudioPath);
      
      if (fs.statSync(mainSegmentPath).size === 0) throw new Error("Merged main video is empty");
    });
    
    // Download background video
    console.log('Downloading background video...');
    await retryOperation(async () => {
      await downloadVideoStream(backgroundVideoId, backgroundSegmentPath);
      
      if (fs.statSync(backgroundSegmentPath).size === 0) {
        throw new Error("Downloaded background video is empty");
      }
    });
    
    // Process main segment
    console.log('Processing main segment...');
    await new Promise((resolve, reject) => {
      ffmpeg(mainSegmentPath)
        .setStartTime(start)
        .duration(duration)
        .outputOptions([
          '-filter_complex', 'fps=30,scale=iw*max(1080/iw\\,(960*1.2)/ih):ih*max(1080/iw\\,(960*1.2)/ih),crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1',
          '-c:v', 'libx264', 
          '-profile:v', 'baseline',
          '-preset', 'veryfast',
          '-crf', '28',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '128k'
        ])
        .output(mainReencodedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Process background segment
    console.log('Processing background segment...');
    await new Promise((resolve, reject) => {
      ffmpeg(backgroundSegmentPath)
        .setStartTime(0)
        .duration(duration)
        .outputOptions([
          '-filter_complex', 'fps=30,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(in_w-1080)/2:(in_h-960)/2,setsar=1',
          '-c:v', 'libx264',
          '-profile:v', 'baseline',
          '-preset', 'veryfast',
          '-crf', '28',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-an'
        ])
        .output(backgroundReencodedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Move to public directory
    console.log('Moving processed videos to public directory...');
    fs.copyFileSync(mainReencodedPath, publicMainPath);
    fs.copyFileSync(backgroundReencodedPath, publicBackgroundPath);
    
    // Cleanup temporary files
    try {
      fs.unlinkSync(mainSegmentPath);
      fs.unlinkSync(backgroundSegmentPath);
      fs.unlinkSync(mainReencodedPath);
      fs.unlinkSync(backgroundReencodedPath);
    } catch (error) {
      console.error('Error cleaning up files:', error);
    }
    
    res.json({ 
      main_video_url: publicMainUrl, 
      background_video_url: publicBackgroundUrl 
    });
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: error.message });
    
    // Cleanup on failure
    try {
      if (fs.existsSync(mainSegmentPath)) fs.unlinkSync(mainSegmentPath);
      if (fs.existsSync(backgroundSegmentPath)) fs.unlinkSync(backgroundSegmentPath);
      if (fs.existsSync(mainReencodedPath)) fs.unlinkSync(mainReencodedPath);
      if (fs.existsSync(backgroundReencodedPath)) fs.unlinkSync(backgroundReencodedPath);
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
  }
});

// Extract audio endpoint - backward compatible with original
app.post('/extract-audio', async (req, res) => {
  const { mainUrl, startSeconds, endSeconds } = req.body;
  const start = parseFloat(startSeconds);
  const end = parseFloat(endSeconds);
  
  if (!mainUrl || isNaN(start) || isNaN(end) || start >= end) {
    return res.status(400).json({ 
      error: 'Invalid or missing fields: mainUrl, startSeconds, endSeconds.' 
    });
  }

  // Determine if mainUrl is a video ID or a full URL
  let videoId;
  if (mainUrl.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(mainUrl)) {
    // mainUrl is already a video ID
    videoId = mainUrl;
  } else {
    // Extract video ID from URL
    const match = mainUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    videoId = match && match[1];
    
    if (!videoId) {
      return res.status(400).json({ 
        error: 'Could not extract valid video ID from URL.' 
      });
    }
  }

  const duration = end - start;
  const timestamp = Date.now();
  const audioOutputPath = path.join(downloadsDir, `audio-${timestamp}.mp3`);
  const tempAudioPath = path.join(downloadsDir, `temp-audio-${timestamp}.mp3`);

  try {
    // Download and extract audio
    console.log('Downloading audio...');
    await retryOperation(async () => {
      await downloadAudioStream(videoId, tempAudioPath);
      
      if (fs.statSync(tempAudioPath).size === 0) {
        throw new Error("Downloaded audio is empty");
      }
      
      // Trim audio to desired segment
      await new Promise((resolve, reject) => {
        ffmpeg(tempAudioPath)
          .setStartTime(start)
          .duration(duration)
          .outputOptions([
            '-c:a', 'libmp3lame',
            '-q:a', '2'
          ])
          .output(audioOutputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      fs.unlinkSync(tempAudioPath);
      
      if (fs.statSync(audioOutputPath).size === 0) {
        throw new Error("Processed audio is empty");
      }
    });
    
    res.sendFile(audioOutputPath, async (err) => {
      if (err) {
        console.error('Error sending file:', err);
        return res.status(500).json({ error: 'Failed to send audio file.' });
      }
      
      // Cleanup
      try {
        fs.unlinkSync(audioOutputPath);
      } catch (error) {
        console.error('Error cleaning up audio file:', error);
      }
      console.log('Cleaned up temporary audio files.');
    });
  } catch (error) {
    console.error('Processing audio error:', error);
    res.status(500).json({ error: error.message });
    
    // Cleanup on failure
    try {
      if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
      if (fs.existsSync(audioOutputPath)) fs.unlinkSync(audioOutputPath);
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
