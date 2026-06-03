# Reuse the battle-tested rlottie + ffmpeg toolchain (powers ezgif).
# It provides /usr/bin/lottie_to_webm.sh + /usr/bin/lottie_to_png + ffmpeg.
FROM edasriyan/lottie-to-webm

# Add Node.js for the thin HTTP wrapper (base image is Alpine).
RUN apk add --no-cache nodejs

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV PORT=8080
EXPOSE 8080

# Override the base image's batch-directory CMD with our HTTP server.
CMD ["node", "/app/server.mjs"]
