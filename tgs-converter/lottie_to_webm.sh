#!/bin/sh
# Adapter for server.mjs, which invokes: lottie_to_webm.sh --output <out> <in>
# Maps that onto python-lottie's lottie_convert.py <in> <out> (the output format
# is inferred from the .webm extension and encoded via ffmpeg).
set -e

output_path=""
input_path=""
while [ $# -gt 0 ]; do
    case "$1" in
        --output)
            output_path="$2"
            shift 2
            ;;
        *)
            input_path="$1"
            shift
            ;;
    esac
done

if [ -z "$input_path" ] || [ -z "$output_path" ]; then
    echo "usage: lottie_to_webm.sh --output <out.webm> <in.tgs>" >&2
    exit 2
fi

exec lottie_convert.py "$input_path" "$output_path"
