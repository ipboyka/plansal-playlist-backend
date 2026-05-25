// ═══════════════════════════════════════════════════════════════════
// PLANSAL — Playlist Frame Backend (Render.com için)
// -------------------------------------------------------------------
//   - yt-dlp ile video info çek (cache'li)
//   - ffmpeg ile belirtilen saniyeden 1 kare yakala
//   - Firebase Storage'a kaydet (sonraki istekler oradan çekecek)
//   - /health endpoint (cron-job.org buraya ping atıp servisi uyutmaz)
//
// Render Free tier:
//   - 750 saat/ay (7/24 çalışacak kadar)
//   - 15 dk hareketsizlikte uyur → cron ping ile uyumaz
//   - Cold start ~30s (sadece çok uzun süre sessiz kalırsa)
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const youtubedl = require('youtube-dl-exec');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── FIREBASE ADMIN INIT ─────────────────────────────────────────
// Render dashboard'unda "Environment" sekmesinden FIREBASE_SERVICE_ACCOUNT
// adında bir env var ekle, değer olarak service-account.json içeriğini yapıştır.
let firebaseReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || (serviceAccount.project_id + '.appspot.com'),
    });
    firebaseReady = true;
    console.log('[Firebase] Bağlantı kuruldu, bucket:', admin.storage().bucket().name);
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT env var yok, cache devre dışı');
  }
} catch (e) {
  console.error('[Firebase] Init hatası:', e.message);
}

// ─── IN-MEMORY VIDEO INFO CACHE ──────────────────────────────────
// yt-dlp her seferinde aynı videoya bakmasın diye 1 saatlik cache
const videoInfoCache = new Map(); // videoUrl → { url, expiresAt }
const VIDEO_INFO_TTL_MS = 60 * 60 * 1000; // 1 saat

// ─── COOKIES dosyası — env var'dan oku ───────────────────────
// YT_COOKIES env var'ına Netscape format cookies.txt içeriği yapıştır
const fs = require('fs');
const path = require('path');
const COOKIES_PATH = path.join('/tmp', 'yt-cookies.txt');
let cookiesAvailable = false;
try {
  if (process.env.YT_COOKIES) {
    fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES, 'utf8');
    cookiesAvailable = true;
    console.log('[Cookies] YT_COOKIES env var bulundu, ' + process.env.YT_COOKIES.length + ' karakter, ' + COOKIES_PATH + ' yazıldı');
  } else {
    console.warn('[Cookies] YT_COOKIES env var YOK. YouTube bot detection riski yüksek!');
  }
} catch (e) {
  console.error('[Cookies] Yazma hatası:', e.message);
}

async function getDirectStreamUrl(videoUrl) {
  const cached = videoInfoCache.get(videoUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  // YouTube 2024'ten beri 'web' client'ı bot olarak işaretliyor.
  // Cookies + farklı client kombinasyonları deneniyor.
  //
  // FORMAT: Sabit format kodu kullanmıyoruz çünkü YouTube format'ları
  // sık değişiyor. Bunun yerine fallback chain kullanıyoruz:
  //   1. mp4 360p video+audio (en uyumlu)
  //   2. mp4 480p video+audio
  //   3. herhangi mp4 (en düşük çözünürlüklü)
  //   4. herhangi format (worst quality)
  // ffmpeg JPEG yakalama için 360p bile yeterli, fazla bandwidth yemek
  // istemiyoruz.
  const FORMAT_CHAIN = 'best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/worst[ext=mp4]/worst';

  const clientStrategies = [
    // 1. Cookies + web client (en başarılı kombinasyon)
    { extractorArgs: 'youtube:player_client=web', useCookies: true },
    // 2. Cookies + tv_embedded
    { extractorArgs: 'youtube:player_client=tv_embedded', useCookies: true },
    // 3. Cookies + android
    { extractorArgs: 'youtube:player_client=android', useCookies: true },
    // 4. Cookies'siz fallback'ler
    { extractorArgs: 'youtube:player_client=tv_embedded,web_safari', useCookies: false },
    { extractorArgs: 'youtube:player_client=ios', useCookies: false },
    { extractorArgs: 'youtube:player_client=mediaconnect', useCookies: false },
  ];

  let lastError = null;
  for (const strategy of clientStrategies) {
    // Cookies istenen ama mevcut değilse bu stratejiyi atla
    if (strategy.useCookies && !cookiesAvailable) continue;

    try {
      console.log(`[yt-dlp] Deneniyor: ${strategy.extractorArgs}${strategy.useCookies ? ' (+cookies)' : ''}`);
      const opts = {
        dumpSingleJson: true,
        format: FORMAT_CHAIN,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        extractorArgs: strategy.extractorArgs,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (strategy.useCookies && cookiesAvailable) {
        opts.cookies = COOKIES_PATH;
      }

      const info = await youtubedl(videoUrl, opts);

      // info.url ya da formats array'inden en iyi URL'i çek
      let url = info.url;
      if (!url && Array.isArray(info.requested_formats) && info.requested_formats.length) {
        url = info.requested_formats[0].url;
      }
      if (!url && Array.isArray(info.formats) && info.formats.length) {
        // Sadece video+audio combined olanları tercih et
        const combined = info.formats.find(f => f.url && f.acodec !== 'none' && f.vcodec !== 'none');
        const anyUrl = info.formats.find(f => f.url);
        url = (combined || anyUrl)?.url;
      }
      if (!url) {
        throw new Error('Stream URL alınamadı (info objesi geldi ama url yok)');
      }
      const fmtNote = info.format || info.format_id || '?';
      console.log(`[yt-dlp] ✅ ${strategy.extractorArgs}${strategy.useCookies ? ' (+cookies)' : ''} başarılı (format: ${fmtNote})`);
      videoInfoCache.set(videoUrl, { url, expiresAt: Date.now() + VIDEO_INFO_TTL_MS });
      return url;
    } catch (e) {
      lastError = e;
      const msg = (e.message || '').substring(0, 300);
      console.warn(`[yt-dlp] ${strategy.extractorArgs}${strategy.useCookies ? ' (+cookies)' : ''} başarısız: ${msg.substring(0, 150)}`);
      continue;
    }
  }

  // Hepsi başarısız
  const errSummary = (lastError?.message || 'unknown').substring(0, 400);
  throw new Error('Tüm yt-dlp client\'ları başarısız. Cookies durumu: ' + (cookiesAvailable ? 'mevcut' : 'YOK (Render env var YT_COOKIES ekle)') + '. Son hata: ' + errSummary);
}

// ─── HEALTH ENDPOINT ─────────────────────────────────────────────
// cron-job.org bu URL'e her 10 dakikada bir ping atacak, servisi uyutmayacak
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    firebase: firebaseReady,
    cookies: cookiesAvailable,
    cacheSize: videoInfoCache.size,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

app.get('/', (req, res) => {
  res.json({ service: 'plansal-playlist-backend', status: 'running' });
});

// ─── FRAME ENDPOINT ──────────────────────────────────────────────
// GET /api/frame?videoId=XXX&time=83
// - videoId zorunlu
// - time saniye cinsinden zorunlu
// - Önce Firebase Storage cache'e bakar (frames/{videoId}_{time}.jpg)
// - Cache'te yoksa: yt-dlp + ffmpeg ile yakala, Storage'a kaydet, JPEG dön
//
app.get('/api/frame', async (req, res) => {
  const videoId = (req.query.videoId || '').trim();
  const time = parseInt(req.query.time, 10);

  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoId geçersiz' });
  }
  if (!Number.isFinite(time) || time < 0 || time > 86400) {
    return res.status(400).json({ error: 'time geçersiz' });
  }

  const cacheKey = `playlistFrames/${videoId}_${time}.jpg`;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // 1) Firebase Storage cache'e bak
    if (firebaseReady) {
      const bucket = admin.storage().bucket();
      const file = bucket.file(cacheKey);
      const [exists] = await file.exists();
      if (exists) {
        // 7 günlük signed URL döndür
        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        return res.json({ ok: true, cached: true, url: signedUrl });
      }
    }

    // 2) Cache miss — yt-dlp + ffmpeg ile yakala
    const streamUrl = await getDirectStreamUrl(videoUrl);

    // ffmpeg ile frame'i belleğe yakala
    const chunks = [];
    await new Promise((resolve, reject) => {
      ffmpeg(streamUrl)
        .setStartTime(time)
        .frames(1)
        .format('image2')
        .outputOptions(['-vcodec', 'mjpeg', '-q:v', '3'])
        .on('error', reject)
        .on('end', resolve)
        .pipe()
        .on('data', (c) => chunks.push(c))
        .on('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    if (!buffer.length) {
      return res.status(500).json({ error: 'Frame boş döndü' });
    }

    // 3) Firebase Storage'a kaydet (varsa)
    let publicUrl = null;
    if (firebaseReady) {
      try {
        const bucket = admin.storage().bucket();
        const file = bucket.file(cacheKey);
        await file.save(buffer, {
          contentType: 'image/jpeg',
          metadata: { cacheControl: 'public, max-age=604800' },
        });
        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        publicUrl = signedUrl;
      } catch (e) {
        console.warn('[Storage] Yazma hatası:', e.message);
      }
    }

    // Storage'a yazılabildiyse URL dön, yazılamadıysa base64 dön (fallback)
    if (publicUrl) {
      return res.json({ ok: true, cached: false, url: publicUrl });
    }
    // Fallback: direkt JPEG body
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('Frame error:', error.message);
    res.status(500).json({ error: error.message || 'Frame yakalanamadı' });
  }
});

// ─── BATCH FRAME ENDPOINT (toplu yakalama) ──────────────────────
// POST /api/frames
// Body: { videoId: "XXX", times: [83, 145, 320, ...] }
// Returns: { results: [{ time, url, cached } | { time, error }] }
//
// Aynı video için yt-dlp sadece 1 kez çağrılır → çok hızlı
//
app.post('/api/frames', async (req, res) => {
  const { videoId, times } = req.body || {};
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoId geçersiz' });
  }
  if (!Array.isArray(times) || times.length === 0 || times.length > 200) {
    return res.status(400).json({ error: 'times bir array olmalı (1-200 öğe)' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const results = [];
  let streamUrl = null;

  // Önce hepsini cache için kontrol et (paralel)
  const cacheChecks = await Promise.all(times.map(async (t) => {
    const time = parseInt(t, 10);
    if (!Number.isFinite(time)) return { time: t, error: 'invalid time' };
    const cacheKey = `playlistFrames/${videoId}_${time}.jpg`;
    if (!firebaseReady) return { time, cacheKey, cached: false };
    try {
      const bucket = admin.storage().bucket();
      const file = bucket.file(cacheKey);
      const [exists] = await file.exists();
      if (exists) {
        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        return { time, cacheKey, cached: true, url: signedUrl };
      }
      return { time, cacheKey, cached: false };
    } catch (e) {
      return { time, cacheKey, cached: false };
    }
  }));

  // Cache hit olanları sonuca ekle
  for (const c of cacheChecks) {
    if (c.cached) results.push({ time: c.time, url: c.url, cached: true });
  }

  // Cache miss olanları yakala — stream URL'i bir kere al
  const missList = cacheChecks.filter(c => !c.cached && !c.error);
  if (missList.length) {
    try {
      streamUrl = await getDirectStreamUrl(videoUrl);
    } catch (e) {
      // Stream alınamazsa hepsine error dön (gerçek hata mesajıyla)
      console.error('[Batch] Stream URL alınamadı:', e.message);
      const errMsg = (e.message || 'stream-fetch-failed').substring(0, 300);
      for (const m of missList) results.push({ time: m.time, error: errMsg });
      results.sort((a, b) => a.time - b.time);
      return res.json({ results });
    }

    // Frame'leri seri olarak yakala (parallel ffmpeg açmak RAM yer)
    for (const m of missList) {
      try {
        const chunks = [];
        await new Promise((resolve, reject) => {
          ffmpeg(streamUrl)
            .setStartTime(m.time)
            .frames(1)
            .format('image2')
            .outputOptions(['-vcodec', 'mjpeg', '-q:v', '3'])
            .on('error', reject)
            .on('end', resolve)
            .pipe()
            .on('data', (c) => chunks.push(c))
            .on('error', reject);
        });

        const buffer = Buffer.concat(chunks);
        if (!buffer.length) {
          results.push({ time: m.time, error: 'empty-frame' });
          continue;
        }

        // Firebase'e kaydet
        let url = null;
        if (firebaseReady) {
          try {
            const bucket = admin.storage().bucket();
            const file = bucket.file(m.cacheKey);
            await file.save(buffer, {
              contentType: 'image/jpeg',
              metadata: { cacheControl: 'public, max-age=604800' },
            });
            const [signedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });
            url = signedUrl;
          } catch (e) {
            console.warn('[Storage] Yazma hatası:', e.message);
          }
        }
        results.push({ time: m.time, url, cached: false });
      } catch (e) {
        results.push({ time: m.time, error: e.message || 'ffmpeg-error' });
      }
    }
  }

  // Time sırasına göre sırala
  results.sort((a, b) => a.time - b.time);
  res.json({ results });
});

// ─── PLAYLIST META ENDPOINT (opsiyonel) ──────────────────────────
// GET /api/playlist?id=PLxxx
// Aslında bu frontend'den de yapılabilir (YouTube API key ile),
// ama frontend'de API key görünür olmasın istersen burada da yapılır
// — şimdilik frontend kendi yapacak, bu sadece reserve

// ─── 404 ─────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint bulunamadı' }));

// ─── ERROR HANDLER ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Sunucu hatası' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Plansal Playlist Backend ${PORT} portunda çalışıyor`);
});
