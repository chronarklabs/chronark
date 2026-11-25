#!/bin/sh
# Encode the rendered conveyor loop into the hero video (mp4 + webm) and a matching poster (frame 0).
# Usage: ./encode-belt.sh [frames dir]   (default blender/render/belt-loop)
set -e
cd "$(dirname "$0")"
F=${1:-blender/render/belt-loop}
# even dimensions for yuv420p
VF="crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0,format=yuv420p"
ffmpeg -v error -y -framerate 30 -i $F/f%04d.png -vf "$VF" -c:v libx264 -preset slow -crf 15 -tune film -profile:v high -movflags +faststart web/img/belt-loop.mp4
ffmpeg -v error -y -framerate 30 -i $F/f%04d.png -vf "$VF" -c:v libvpx-vp9 -b:v 0 -crf 22 -row-mt 1 -deadline good -cpu-used 1 -pass 1 -an -f null /dev/null
ffmpeg -v error -y -framerate 30 -i $F/f%04d.png -vf "$VF" -c:v libvpx-vp9 -b:v 0 -crf 22 -row-mt 1 -deadline good -cpu-used 1 -pass 2 web/img/belt-loop.webm
rm -f ffmpeg2pass-0.log
python3 -c "from PIL import Image; Image.open('$F/f0000.png').convert('RGB').save('web/img/belt-poster.jpg', quality=90, optimize=True, progressive=True)"
ls -la web/img/belt-loop.* web/img/belt-poster.jpg
