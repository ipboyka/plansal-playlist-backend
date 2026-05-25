# ════════════════════════════════════════════════════════════════
# Plansal Playlist Backend Dockerfile (Render.com)
# ────────────────────────────────────────────────────────────────
# Node.js 20 + yt-dlp + ffmpeg.
# YouTube anti-bot sistemi sık güncellendiği için yt-dlp'nin EN SON
# sürümünü her build'de indiriyoruz.
# ────────────────────────────────────────────────────────────────
FROM node:20-slim

# Sistem paketleri: python3 (yt-dlp için), ffmpeg, curl
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# En güncel yt-dlp'yi GitHub'tan indir (her image build'inde yenilenir)
# YouTube anti-bot için bu kritik — yt-dlp her hafta yeni client desteği ekliyor
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

WORKDIR /app

# Önce package.json kopyala (Docker cache layer optimizasyonu)
COPY package*.json ./

# Bağımlılıkları kur
RUN npm install --omit=dev

# Uygulama kodunu kopyala
COPY server.js ./

# youtube-dl-exec'in kendi yt-dlp'sini sistem yt-dlp ile değiştir
# (Bu hayati! Çünkü youtube-dl-exec eski paketlenmiş yt-dlp kullanıyor)
RUN if [ -d "node_modules/youtube-dl-exec/bin" ]; then \
      cp /usr/local/bin/yt-dlp node_modules/youtube-dl-exec/bin/yt-dlp; \
    fi

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]

