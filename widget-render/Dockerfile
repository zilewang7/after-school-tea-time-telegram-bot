# Headless Chromium PNG renderer for Telegram widget HTML.
#
# Chromium comes from Alpine so the image stays small. font-noto-cjk is what
# turns Chinese/Japanese text into glyphs instead of tofu boxes; font-noto-emoji
# covers the emoji model-written HTML tends to contain (Telegram renders them in
# colour, so the preview image should too).
#
# No npm dependencies: server.mjs drives Chromium over raw CDP with node's
# built-in WebSocket.
FROM alpine:3.24

RUN apk add --no-cache nodejs chromium font-noto-cjk font-noto-emoji

WORKDIR /app
# --chmod: the build context may hand over a 0600 file, and the unprivileged
# renderer user must be able to read it
COPY --chmod=644 server.mjs /app/server.mjs

# Chromium needs a writable HOME/user-data-dir; the container mounts /tmp as
# tmpfs and the renderer points both at a scratch directory there. Running as a
# non-root user keeps the --no-sandbox trade-off contained to this sidecar
# (which has no secrets, no database and no network route out).
RUN adduser -D -H renderer
USER renderer

ENV PORT=8099
EXPOSE 8099
CMD ["node", "--max-old-space-size=256", "/app/server.mjs"]
