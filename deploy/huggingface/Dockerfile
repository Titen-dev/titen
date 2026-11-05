# Titen on Hugging Face Spaces (Docker SDK, free CPU, no credit card).
# Upload this file and README.md from this folder to a new Docker Space.
# The image pulls the latest code from GitHub on every (re)build.
FROM node:22-alpine

RUN apk add --no-cache git

# Changes whenever main gets a new commit, so a rebuild never reuses old code.
ADD https://api.github.com/repos/Titen-dev/titen/commits/main /tmp/latest-commit.json
RUN git clone --depth 1 https://github.com/Titen-dev/titen.git /app && rm -rf /app/.git

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    TRUST_PROXY=1 \
    WARM_TRENDS=1 \
    TITEN_CACHE_DIR=/tmp/titen-cache \
    FRAME_ANCESTORS=https://huggingface.co

# Spaces run containers as uid 1000, which is the "node" user in this image.
USER node
EXPOSE 7860
CMD ["node", "web/server.js"]
