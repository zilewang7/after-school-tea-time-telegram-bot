# arm64-native tgs -> webm converter.
#
# The previous base image (edasriyan/lottie-to-webm) ships amd64-only compiled
# binaries (lottie_to_png); on this aarch64 host they fail with `spawn ENOEXEC`,
# so every animated-sticker conversion errored out. This rebuilds the pipeline
# natively with python-lottie (a pure-Python Lottie renderer) + ffmpeg, both of
# which are architecture-independent.
FROM node:20-bookworm-slim

# python-lottie rasterizes frames via cairo (cairosvg/pillow); ffmpeg encodes webm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg libcairo2 libglib2.0-0 \
    && pip3 install --no-cache-dir --break-system-packages lottie cairosvg pillow opencv-python-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs /app/server.mjs

# Adapter that maps server.mjs's `lottie_to_webm.sh --output OUT IN` invocation
# onto python-lottie's lottie_convert.py. Keeping the default CONVERT_SCRIPT
# name means server.mjs needs no change.
COPY lottie_to_webm.sh /usr/local/bin/lottie_to_webm.sh
RUN chmod +x /usr/local/bin/lottie_to_webm.sh

ENV PORT=8080
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
