#!/bin/sh
# Encode the rendered conveyor loop into the hero video (mp4 + webm) and a matching poster (frame 0).
set -e
cd "$(dirname "$0")"
F=blender/render/belt-loop
ffmpeg -v error -y -framerate 30 -i $F/f%04d.png -vf "crop=1612:964:0:0,format=yuv420p" -c:v libx264 -preset slow -crf 20 -movflags +faststart web/img/belt-loop.mp4
ffmpeg -v error -y -framerate 30 -i $F/f%04d.png -vf "crop=1612:964:0:0,format=yuv420p" -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 web/img/belt-loop.webm
python3 -c "from PIL import Image; Image.open('$F/f0000.png').convert('RGB').save('web/img/belt-poster.jpg', quality=88, optimize=True, progressive=True)"
ls -la web/img/belt-loop.* web/img/belt-poster.jpg
